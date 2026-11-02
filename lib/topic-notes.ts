import "server-only";
import { callJSON, models } from "@/lib/ai/openrouter";
import { StudyNotesSchema, type StudyNotes } from "@/lib/ai/schemas";
import { notesSystemPrompt, notesUserPrompt } from "@/lib/ai/prompts/notes";
import { UserFacingError } from "@/lib/http";
import { pageRange } from "@/lib/mastery";
import { sanitizeText, wrapNotes } from "@/lib/safety/injection";
import { spendLLMCalls } from "@/lib/safety/limits";
import type { UserContext } from "@/lib/db/context";

const NOTES_CHARS = 14_000;
const UNDEFINED_COLUMN = "42703"; // study_notes column not added yet (0002 not run)

// Returns cached study notes for a topic, or generates, validates and caches them.
export async function getStudyNotes(ctx: UserContext, topicId: string): Promise<StudyNotes> {
  let cacheAvailable = true;
  let { data: topic, error } = await ctx.db
    .from("topics")
    .select("id, course_id, name, page_start, page_end, study_notes")
    .eq("id", topicId)
    .maybeSingle();
  if (error?.code === UNDEFINED_COLUMN) {
    cacheAvailable = false;
    ({ data: topic, error } = await ctx.db
      .from("topics")
      .select("id, course_id, name, page_start, page_end")
      .eq("id", topicId)
      .maybeSingle());
  }
  if (error) throw error;
  if (!topic) throw new UserFacingError("We couldn't find that topic.", 404);

  const cached = cacheAvailable ? StudyNotesSchema.safeParse(topic.study_notes) : null;
  if (cached?.success) return cached.data;

  const { data: pages, error: pageError } = await ctx.db
    .from("pages")
    .select("page_number, text")
    .eq("course_id", topic.course_id)
    .gte("page_number", topic.page_start)
    .lte("page_number", topic.page_end)
    .order("page_number");
  if (pageError) throw pageError;
  const usable = (pages ?? []).filter((p) => (p.text as string).trim().length > 0);
  if (usable.length === 0) throw new UserFacingError("These pages don't have any readable text.");
  const perPage = Math.max(800, Math.floor(NOTES_CHARS / usable.length));
  const shown = new Set(usable.map((p) => p.page_number as number));

  await spendLLMCalls({ ...ctx, courseId: topic.course_id });
  const raw = await callJSON({
    model: models.professor(),
    system: notesSystemPrompt(),
    user: notesUserPrompt(
      `${topic.name} (${pageRange(topic.page_start, topic.page_end)})`,
      wrapNotes(usable.map((p) => ({ page: p.page_number as number, text: (p.text as string).slice(0, perPage) }))),
    ),
    schema: StudyNotesSchema,
    temperature: 0,
    name: "study_notes",
  });

  // Grounding: keep only points whose pages were actually shown.
  const okPages = (ps: number[]) => ps.length > 0 && ps.every((p) => shown.has(p));
  const notes: StudyNotes = {
    overview: sanitizeText(raw.overview).slice(0, 400),
    sections: raw.sections
      .map((s) => ({
        heading: sanitizeText(s.heading).slice(0, 80),
        points: s.points
          .filter((pt) => okPages(pt.pages))
          .map((pt) => ({ text: sanitizeText(pt.text).slice(0, 300), pages: [...new Set(pt.pages)].sort((a, b) => a - b) })),
      }))
      .filter((s) => s.points.length > 0),
    key_terms: raw.key_terms
      .filter((k) => shown.has(k.page))
      .map((k) => ({ term: sanitizeText(k.term).slice(0, 60), meaning: sanitizeText(k.meaning).slice(0, 200), page: k.page })),
    watch_out: raw.watch_out
      .filter((w) => shown.has(w.page))
      .map((w) => ({ text: sanitizeText(w.text).slice(0, 250), page: w.page })),
  };
  if (notes.sections.length === 0) {
    throw new UserFacingError("I couldn't write notes I could back up with page numbers. Please try again.", 422);
  }

  if (cacheAvailable) {
    await ctx.db.from("topics").update({ study_notes: notes }).eq("id", topicId);
  }
  return notes;
}
