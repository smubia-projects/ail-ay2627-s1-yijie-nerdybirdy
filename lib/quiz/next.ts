import "server-only";
import { z } from "zod";
import { callJSON, models } from "@/lib/ai/openrouter";
import {
  QuestionPrivateSchema,
  QuestionPublicSchema,
  QuizFormat,
  VerifierSchema,
} from "@/lib/ai/schemas";
import { generateSystemPrompt, generateUserPrompt } from "@/lib/ai/prompts/generate";
import { verifySystemPrompt, verifyUserPrompt } from "@/lib/ai/prompts/verify";
import { UserFacingError } from "@/lib/http";
import { orderTopicsForReview, pageRange, targetLevel } from "@/lib/mastery";
import { comebackFormat, FORMATS, formatsForLevel } from "@/lib/quiz/formats";
import { logSafetyEvent } from "@/lib/safety/events";
import { neutralizeDelimiters, wrapNotes } from "@/lib/safety/injection";
import { spendLLMCalls } from "@/lib/safety/limits";
import type { UserContext } from "@/lib/db/context";
import type { PublicQuestion, TopicRef } from "@/lib/quiz/types";

const MAX_ATTEMPTS_PER_TOPIC = 3; // first try + 2 regenerations
const TOPICS_TO_TRY = 2;
const DEADLINE_MS = 200_000; // stop starting new attempts after this
const TOPIC_NOTES_CHARS = 12_000;

// ---------- Request ----------

export const NextRequestSchema = z.object({
  courseId: z.uuid(),
  topic: z.union([z.uuid(), z.enum(["mix", "weak"])]),
  format: z.union([QuizFormat, z.literal("surprise")]),
  avoidTopicIds: z.array(z.uuid()).max(10).default([]),
});
export type NextRequest = z.infer<typeof NextRequestSchema>;

// What the browser receives (never any key material): see lib/quiz/types.ts.

type Topic = TopicRef & {
  summary: string;
  mastery_level: number;
  level_progress: number;
  danger_zone: boolean;
  last_practiced_at: string | null;
};

type LatestAttempt = {
  verdict: string;
  key_point_results: { point: string; hit: boolean }[] | null;
  format: QuizFormat;
};

class VerificationFailedError extends Error {}

export async function nextQuestion(ctx: UserContext, req: NextRequest): Promise<PublicQuestion> {
  const started = Date.now();

  const { data: course, error: courseError } = await ctx.db
    .from("courses")
    .select("id, page_count")
    .eq("id", req.courseId)
    .maybeSingle();
  if (courseError) throw courseError;
  if (!course) throw new UserFacingError("We couldn't find that course.", 404);

  const { data: topicRows, error: topicError } = await ctx.db
    .from("topics")
    .select("id, name, summary, page_start, page_end, mastery_level, level_progress, danger_zone, last_practiced_at")
    .eq("course_id", req.courseId);
  if (topicError) throw topicError;
  const topics = (topicRows ?? []) as Topic[];
  if (topics.length === 0) throw new UserFacingError("This course has no topics yet.");

  const latest = await latestAttemptByTopic(ctx, req.courseId);
  const candidates = chooseTopics(topics, req, latest);
  if (candidates.length === 0) throw new UserFacingError("We couldn't find that topic.", 404);

  for (const topic of candidates.slice(0, TOPICS_TO_TRY)) {
    if (Date.now() - started > DEADLINE_MS) break;
    try {
      return await generateForTopic(ctx, course.page_count as number, topic, topics, req, latest.get(topic.id), started);
    } catch (err) {
      if (!(err instanceof VerificationFailedError)) throw err;
    }
  }
  throw new UserFacingError(
    "I couldn't write a question I was confident about this time 🦉 Please try again, or pick a different topic.",
    422,
  );
}

async function latestAttemptByTopic(ctx: UserContext, courseId: string): Promise<Map<string, LatestAttempt>> {
  const { data, error } = await ctx.db
    .from("attempts")
    .select("topic_id, verdict, key_point_results, created_at, questions(format)")
    .eq("course_id", courseId)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw error;
  const map = new Map<string, LatestAttempt>();
  for (const row of data ?? []) {
    if (map.has(row.topic_id)) continue;
    const q = row.questions as unknown as { format: QuizFormat } | null;
    map.set(row.topic_id, {
      verdict: row.verdict,
      key_point_results: row.key_point_results as LatestAttempt["key_point_results"],
      format: q?.format ?? "explain",
    });
  }
  return map;
}

function chooseTopics(topics: Topic[], req: NextRequest, latest: Map<string, LatestAttempt>): Topic[] {
  const ordered = orderTopicsForReview(topics);
  if (req.topic !== "mix" && req.topic !== "weak") {
    const chosen = topics.find((t) => t.id === req.topic);
    if (!chosen) return [];
    return [chosen, ...ordered.filter((t) => t.id !== chosen.id)];
  }
  let pool = ordered;
  if (req.topic === "weak") {
    const weak = ordered.filter((t) => t.danger_zone || (latest.get(t.id) && latest.get(t.id)!.verdict !== "correct"));
    if (weak.length > 0) pool = [...weak, ...ordered.filter((t) => !weak.includes(t))];
  }
  const avoid = new Set(req.avoidTopicIds);
  const fresh = pool.filter((t) => !avoid.has(t.id));
  return fresh.length > 0 ? [...fresh, ...pool.filter((t) => avoid.has(t.id))] : pool;
}

function pickFormat(
  req: NextRequest,
  topic: Topic,
  topicCount: number,
  comeback: { missedFormat: QuizFormat } | null,
): QuizFormat {
  let format: QuizFormat;
  if (comeback) {
    format =
      req.format !== "surprise" && req.format !== comeback.missedFormat
        ? req.format
        : comebackFormat(comeback.missedFormat);
  } else if (req.format !== "surprise") {
    format = req.format;
  } else {
    const options = formatsForLevel(targetLevel(topic.mastery_level));
    format = options[Math.floor(Math.random() * options.length)];
  }
  if (format === "connect" && topicCount < 2) format = "apply";
  return format;
}

async function loadPages(ctx: UserContext, courseId: string, ranges: [number, number][]) {
  const wanted = new Set<number>();
  for (const [a, b] of ranges) for (let p = a; p <= b; p++) wanted.add(p);
  const { data, error } = await ctx.db
    .from("pages")
    .select("page_number, text")
    .eq("course_id", courseId)
    .in("page_number", [...wanted])
    .order("page_number");
  if (error) throw error;
  const pages = (data ?? []).filter((p) => (p.text as string).trim().length > 0);
  const perPage = Math.max(500, Math.floor(TOPIC_NOTES_CHARS / Math.max(1, pages.length)));
  return pages.map((p) => ({ page: p.page_number as number, text: (p.text as string).slice(0, perPage) }));
}

function generationSchema(format: QuizFormat, pageCount: number) {
  const page = z.number().int().min(1).max(pageCount);
  return z
    .object({
      public: QuestionPublicSchema,
      private: QuestionPrivateSchema.extend({
        key_points: z.array(z.object({ point: z.string().min(1).max(300), page })).min(2).max(4),
        source_pages: z.array(page).min(1),
        original_statement: z.object({ text: z.string().min(1).max(1_000), page }).nullable(),
      }),
    })
    .superRefine((v, c) => {
      if (format === "mcq") {
        if (!v.public.options) c.addIssue({ code: "custom", message: "mcq needs exactly 4 options" });
        else if (new Set(v.public.options.map((o) => o.trim().toLowerCase())).size !== 4)
          c.addIssue({ code: "custom", message: "the 4 options must all be different" });
        if (v.private.correct_option === null) c.addIssue({ code: "custom", message: "mcq needs correct_option" });
        if (!v.private.option_details) c.addIssue({ code: "custom", message: "mcq needs option_details" });
      }
      if (format === "spot_the_mistake" && !v.private.original_statement) {
        c.addIssue({ code: "custom", message: "spot_the_mistake needs original_statement" });
      }
    });
}

type Generated = z.infer<ReturnType<typeof generationSchema>>;

// Normalize per format and shuffle mcq options so the answer isn't always "A".
function normalize(gen: Generated, format: QuizFormat): Generated {
  if (format !== "mcq") {
    return {
      public: { ...gen.public, options: null },
      private: { ...gen.private, correct_option: null, option_details: null },
    };
  }
  const options = gen.public.options!;
  const details = gen.private.option_details!;
  const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
  return {
    public: { ...gen.public, options: order.map((i) => options[i]) },
    private: {
      ...gen.private,
      option_details: order.map((i) => details[i]),
      correct_option: order.indexOf(gen.private.correct_option!),
    },
  };
}

function passes(v: z.infer<typeof VerifierSchema>, format: QuizFormat): { ok: boolean; failed: string[] } {
  const failed: string[] = [];
  if (!v.answerable_from_notes) failed.push("answerable_from_notes");
  if (!v.answer_key_correct) failed.push("answer_key_correct");
  if (!v.unambiguous) failed.push("unambiguous");
  if (format === "mcq" && v.single_correct_option !== true) failed.push("single_correct_option");
  if (format === "spot_the_mistake" && v.exactly_one_error !== true) failed.push("exactly_one_error");
  return { ok: failed.length === 0, failed };
}

export async function verifyQuestion(
  ctx: UserContext & { courseId: string },
  format: QuizFormat,
  notesBlock: string,
  gen: Generated,
): Promise<{ ok: boolean; failed: string[]; issues: string[] }> {
  await spendLLMCalls(ctx);
  const questionJSON = neutralizeDelimiters(JSON.stringify({ format, ...gen }, null, 1));
  const v = await callJSON({
    model: models.checker(),
    system: verifySystemPrompt(format),
    user: verifyUserPrompt(notesBlock, questionJSON),
    schema: VerifierSchema,
    temperature: 0,
    name: "verification",
  });
  const result = passes(v, format);
  return {
    ...result,
    issues: v.issues.length > 0 ? v.issues : result.failed.map((f) => `Failed check: ${f}`),
  };
}

async function generateForTopic(
  ctx: UserContext,
  pageCount: number,
  topic: Topic,
  topics: Topic[],
  req: NextRequest,
  latest: LatestAttempt | undefined,
  started: number,
): Promise<PublicQuestion> {
  const missed = latest && latest.verdict !== "correct"
    ? (latest.key_point_results ?? []).filter((k) => !k.hit).map((k) => k.point)
    : [];
  const comeback = missed.length > 0 ? { missedFormat: latest!.format, points: missed } : null;
  const format = pickFormat(req, topic, topics.length, comeback);
  const level = FORMATS[format].level;

  const others = topics.filter((t) => t.id !== topic.id);
  const second = format === "connect" ? others[Math.floor(Math.random() * others.length)] : null;

  const ranges: [number, number][] = [[topic.page_start, topic.page_end]];
  if (second) ranges.push([second.page_start, second.page_end]);
  const pages = await loadPages(ctx, req.courseId, ranges);
  if (pages.length === 0) throw new VerificationFailedError("no text for topic");
  const shownPages = new Set(pages.map((p) => p.page));
  const notesBlock = wrapNotes(pages);

  const { data: prev } = await ctx.db
    .from("questions")
    .select("public_payload")
    .eq("topic_id", topic.id)
    .order("created_at", { ascending: false })
    .limit(5);
  const previousQuestions = (prev ?? [])
    .map((q) => neutralizeDelimiters(String((q.public_payload as { question_markdown?: string })?.question_markdown ?? "")).slice(0, 300))
    .filter(Boolean);

  const topicLine = (t: Topic) => `${t.name} (${pageRange(t.page_start, t.page_end)})`;
  const otherTopics =
    format === "mcq" && others.length > 0
      ? others.map((t) => `- ${neutralizeDelimiters(t.name)}: ${neutralizeDelimiters(t.summary)}`).join("\n")
      : null;

  const spendCtx = { ...ctx, courseId: req.courseId };
  let issues: string[] | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TOPIC; attempt++) {
    if (Date.now() - started > DEADLINE_MS) break;

    await spendLLMCalls(spendCtx);
    const raw = await callJSON({
      model: models.professor(),
      system: generateSystemPrompt(format, pageCount),
      user: generateUserPrompt({
        topicLine: topicLine(topic),
        secondTopicLine: second ? topicLine(second) : null,
        notesBlock,
        otherTopics,
        comebackPoints: comeback?.points ?? null,
        previousQuestions,
        issues,
      }),
      schema: generationSchema(format, pageCount),
      temperature: 0.7,
      name: "quiz_question",
    });
    const gen = normalize(raw, format);

    // Deterministic check: every page must be one we actually showed.
    const usedPages = [
      ...gen.private.source_pages,
      ...gen.private.key_points.map((k) => k.page),
      ...(gen.private.original_statement ? [gen.private.original_statement.page] : []),
    ];
    const badPages = [...new Set(usedPages.filter((p) => !shownPages.has(p)))];

    let verdict: { ok: boolean; failed: string[]; issues: string[] };
    if (badPages.length > 0) {
      verdict = {
        ok: false,
        failed: ["pages_out_of_range"],
        issues: [`Only use pages ${[...shownPages].join(", ")}. Pages ${badPages.join(", ")} are not in the notes shown.`],
      };
    } else {
      verdict = await verifyQuestion(spendCtx, format, notesBlock, gen);
    }

    if (verdict.ok) return saveQuestion(ctx, req.courseId, topic, second, format, level, gen, !!comeback);

    await logSafetyEvent(ctx.db, {
      type: "verification_failed",
      courseId: req.courseId,
      detail: { format, attempt, failed: verdict.failed, issue_count: verdict.issues.length },
    });
    issues = verdict.issues.slice(0, 6);
  }
  throw new VerificationFailedError("all attempts failed");
}

async function saveQuestion(
  ctx: UserContext,
  courseId: string,
  topic: Topic,
  second: Topic | null,
  format: QuizFormat,
  level: number,
  gen: Generated,
  comeback: boolean,
): Promise<PublicQuestion> {
  const publicPayload = {
    question_markdown: gen.public.question_markdown,
    options: gen.public.options,
    hint: gen.public.hint,
  };
  const sourcePages = [
    ...new Set([...gen.private.source_pages, ...gen.private.key_points.map((k) => k.page)]),
  ].sort((a, b) => a - b);

  const { data: q, error } = await ctx.db
    .from("questions")
    .insert({
      course_id: courseId,
      topic_id: topic.id,
      format,
      level,
      public_payload: publicPayload,
      source_pages: sourcePages,
      verified: true,
    })
    .select("id")
    .single();
  if (error) throw error;

  const { error: keyError } = await ctx.db
    .from("question_keys")
    .insert({
      question_id: q.id,
      user_id: ctx.userId,
      private_payload: { ...gen.private, second_topic_id: second?.id ?? null, comeback },
    });
  if (keyError) {
    await ctx.db.from("questions").delete().eq("id", q.id);
    throw keyError;
  }

  const ref = (t: Topic): TopicRef => ({ id: t.id, name: t.name, page_start: t.page_start, page_end: t.page_end });
  return {
    questionId: q.id as string,
    format,
    formatLabel: FORMATS[format].label,
    level,
    topic: ref(topic),
    secondTopic: second ? ref(second) : null,
    comeback,
    ...publicPayload,
  };
}
