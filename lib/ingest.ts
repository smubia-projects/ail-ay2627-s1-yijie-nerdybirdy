import "server-only";
import { z } from "zod";
import { callJSON, embed, models } from "@/lib/ai/openrouter";
import { TopicSchema, LIMITS } from "@/lib/ai/schemas";
import { topicMapSystemPrompt, topicMapUserPrompt } from "@/lib/ai/prompts/topics";
import { chunkPages } from "@/lib/rag/chunk";
import { sanitizeText, scanForInjection, wrapNotes } from "@/lib/safety/injection";
import { logSafetyEvent } from "@/lib/safety/events";
import { spendLLMCalls } from "@/lib/safety/limits";
import { UserFacingError } from "@/lib/http";
import type { UserContext } from "@/lib/db/context";

const EMBED_BATCH = 64;
// Total characters of notes sent to the topic-map call.
const TOPIC_MAP_CHAR_BUDGET = 100_000;

type CourseRow = { id: string; page_count: number; flagged_pages: number[] };

async function loadCourse(ctx: UserContext, courseId: string): Promise<CourseRow> {
  const { data, error } = await ctx.db
    .from("courses")
    .select("id, page_count, flagged_pages")
    .eq("id", courseId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new UserFacingError("We couldn't find that course.", 404);
  return data as CourseRow;
}

// ---------- Create course ----------

export async function createCourse(
  ctx: UserContext,
  input: { name: string; examDate: string | null; pageCount: number },
): Promise<{ id: string }> {
  const { count, error: countError } = await ctx.db
    .from("courses")
    .select("id", { count: "exact", head: true });
  if (countError) throw countError;
  if ((count ?? 0) >= LIMITS.maxCoursesPerUser) {
    throw new UserFacingError(
      `You can have up to ${LIMITS.maxCoursesPerUser} courses at a time. Delete one to add another.`,
    );
  }
  const name = sanitizeText(input.name).slice(0, LIMITS.maxCourseNameChars) || "My notes";
  const { data, error } = await ctx.db
    .from("courses")
    .insert({ name, exam_date: input.examDate, page_count: input.pageCount })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id as string };
}

// ---------- Ingest one batch of pages ----------

export async function ingestBatch(
  ctx: UserContext,
  courseId: string,
  rawPages: { page: number; text: string }[],
): Promise<{ flaggedPages: number[]; chunkCount: number }> {
  const course = await loadCourse(ctx, courseId);
  if (rawPages.some((p) => p.page > course.page_count)) {
    throw new UserFacingError("Some pages are outside this course's page range.");
  }

  // 1–3. Sanitize and scan each page.
  const pages = rawPages.map((p) => ({ page: p.page, text: sanitizeText(p.text) }));
  const flagged: { page: number; patterns: string[] }[] = [];
  for (const p of pages) {
    const scan = scanForInjection(p.text);
    if (scan.flagged) flagged.push({ page: p.page, patterns: scan.patterns });
  }

  // 4. Store pages (upsert so a retried batch doesn't fail).
  const { error: pageError } = await ctx.db.from("pages").upsert(
    pages.map((p) => ({ course_id: courseId, page_number: p.page, text: p.text })),
    { onConflict: "course_id,page_number" },
  );
  if (pageError) throw pageError;

  // 5. Chunk.
  const chunks = chunkPages(pages);

  // 6. Embed and insert (clearing any chunks from a previous attempt).
  const pageNumbers = pages.map((p) => p.page);
  const { error: delError } = await ctx.db
    .from("chunks")
    .delete()
    .eq("course_id", courseId)
    .in("page_number", pageNumbers);
  if (delError) throw delError;

  if (chunks.length > 0) {
    await spendLLMCalls({ ...ctx, courseId }, Math.ceil(chunks.length / EMBED_BATCH));
    const vectors = await embed(chunks.map((c) => `Page ${c.page}: ${c.content}`));
    const { error: chunkError } = await ctx.db.from("chunks").insert(
      chunks.map((c, i) => ({
        course_id: courseId,
        page_number: c.page,
        content: c.content,
        embedding: vectors[i],
      })),
    );
    if (chunkError) throw chunkError;
  }

  if (flagged.length > 0) {
    const flaggedPages = flagged.map((f) => f.page);
    const merged = [...new Set([...(course.flagged_pages ?? []), ...flaggedPages])].sort(
      (a, b) => a - b,
    );
    const { error } = await ctx.db
      .from("courses")
      .update({ flagged_pages: merged })
      .eq("id", courseId);
    if (error) throw error;
    await logSafetyEvent(ctx.db, {
      type: "injection_flagged",
      courseId,
      detail: {
        source: "notes",
        pages: flaggedPages,
        patterns: [...new Set(flagged.flatMap((f) => f.patterns))],
      },
    });
  }

  return { flaggedPages: flagged.map((f) => f.page), chunkCount: chunks.length };
}

// ---------- Finalize: build the topic map ----------

function topicMapSchema(pageCount: number) {
  const page = z.number().int().min(1).max(pageCount);
  return z.object({
    topics: z
      .array(
        TopicSchema.extend({ page_start: page, page_end: page }).refine(
          (t) => t.page_end >= t.page_start,
          { message: "page_end must be >= page_start" },
        ),
      )
      .min(4)
      .max(12),
  });
}

export async function finalizeCourse(
  ctx: UserContext,
  courseId: string,
): Promise<{ topicCount: number; flaggedPages: number[] }> {
  const course = await loadCourse(ctx, courseId);
  const { data: pages, error } = await ctx.db
    .from("pages")
    .select("page_number, text")
    .eq("course_id", courseId)
    .order("page_number");
  if (error) throw error;
  if (!pages || pages.length === 0) {
    throw new UserFacingError("We couldn't find any text in these notes.");
  }

  // Give every page a fair share of the character budget.
  const perPage = Math.max(400, Math.floor(TOPIC_MAP_CHAR_BUDGET / pages.length));
  const notes = wrapNotes(
    pages
      .filter((p) => (p.text as string).trim().length > 0)
      .map((p) => ({ page: p.page_number as number, text: (p.text as string).slice(0, perPage) })),
  );

  await spendLLMCalls({ ...ctx, courseId });
  const result = await callJSON({
    model: models.professor(),
    system: topicMapSystemPrompt(course.page_count),
    user: topicMapUserPrompt(notes),
    schema: topicMapSchema(course.page_count),
    temperature: 0,
    name: "topic_map",
  });

  const { error: delError } = await ctx.db.from("topics").delete().eq("course_id", courseId);
  if (delError) throw delError;
  const { error: insError } = await ctx.db.from("topics").insert(
    result.topics.map((t) => ({
      course_id: courseId,
      name: sanitizeText(t.name),
      summary: sanitizeText(t.summary),
      page_start: t.page_start,
      page_end: t.page_end,
    })),
  );
  if (insError) throw insError;

  return { topicCount: result.topics.length, flaggedPages: course.flagged_pages ?? [] };
}
