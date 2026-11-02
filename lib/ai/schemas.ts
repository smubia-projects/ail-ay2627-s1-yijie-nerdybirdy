import { z } from "zod";

// LLM output schemas. These are also turned into JSON Schema for structured
// output, so use .nullable() instead of .optional() (strict mode needs every
// key to be present). Page numbers are range-checked against the course by
// the caller, since the schema can't know the page count.

const page = z.number().int().min(1);

// ---------- Limits shared by routes and UI ----------

export const LIMITS = {
  maxPdfBytes: 25 * 1024 * 1024,
  maxPages: 60, // AI Lodge demo (was 150)
  maxCoursesPerUser: 3, // AI Lodge demo (was 5)
  ingestBatchPages: 20,
  maxPageChars: 20_000,
  minReadablePageChars: 30,
  maxQuestionChars: 1_000,
  maxAnswerChars: 2_000,
  maxCourseNameChars: 120,
  chatHistoryMessages: 6,
} as const;

// ---------- Request bodies ----------

export const IngestBatchSchema = z.object({
  courseId: z.uuid(),
  pages: z
    .array(
      z.object({
        page: z.number().int().min(1).max(LIMITS.maxPages),
        text: z.string().max(LIMITS.maxPageChars),
      }),
    )
    .min(1)
    .max(LIMITS.ingestBatchPages),
});

// ---------- Topic map (/api/ingest/finalize) ----------

export const TopicSchema = z.object({
  name: z.string().min(1).max(80),
  summary: z.string().min(1).max(400),
  page_start: page,
  page_end: page,
});

export const TopicMapSchema = z.object({
  topics: z.array(TopicSchema).min(4).max(12),
});

// ---------- Ask the Professor ----------

export const AskStatus = z.enum([
  "answered",
  "not_in_notes",
  "integrity_boundary",
  "wellbeing_support",
  "unsafe_request",
]);
export type AskStatus = z.infer<typeof AskStatus>;

export const AskResponseSchema = z.object({
  status: AskStatus,
  answer_markdown: z.string().max(6_000),
  cited_pages: z.array(page),
});

// General-knowledge "Explain anyway" mode: no citations allowed.
export const GeneralAnswerSchema = z.object({
  status: z.enum(["answered", "integrity_boundary", "wellbeing_support", "unsafe_request"]),
  answer_markdown: z.string().max(6_000),
});

// ---------- Quiz ----------

export const QuizFormat = z.enum(["mcq", "explain", "spot_the_mistake", "apply", "connect"]);
export type QuizFormat = z.infer<typeof QuizFormat>;

export const Confidence = z.enum(["guessing", "fairly_sure", "very_sure"]);
export const Verdict = z.enum(["correct", "partial", "incorrect"]);
export const MistakeType = z.enum([
  "none",
  "misconception",
  "mixed_up",
  "incomplete",
  "careless_slip",
]);

// What the browser may see. Never add correctness, keys or key points here.
export const QuestionPublicSchema = z.object({
  question_markdown: z.string().min(1).max(3_000),
  options: z.array(z.string().min(1).max(400)).length(4).nullable(), // mcq only
  hint: z.string().min(1).max(500),
});

// Server-only. Stored in question_keys.
export const QuestionPrivateSchema = z.object({
  answer_key: z.string().min(1).max(3_000),
  correct_option: z.number().int().min(0).max(3).nullable(), // mcq only (index)
  option_details: z
    .array(
      z.object({
        why: z.string().min(1).max(400), // why it is right, or why it is tempting
        concept: z.string().min(1).max(120),
      }),
    )
    .length(4)
    .nullable(), // mcq only
  key_points: z
    .array(z.object({ point: z.string().min(1).max(300), page }))
    .min(2)
    .max(4),
  model_answer: z.string().min(1).max(3_000),
  source_pages: z.array(page).min(1),
  original_statement: z
    .object({ text: z.string().min(1).max(1_000), page })
    .nullable(), // spot_the_mistake only
});

export const GeneratedQuestionSchema = z.object({
  public: QuestionPublicSchema,
  private: QuestionPrivateSchema,
});

export const VerifierSchema = z.object({
  answerable_from_notes: z.boolean(),
  answer_key_correct: z.boolean(),
  single_correct_option: z.boolean().nullable(), // mcq only
  exactly_one_error: z.boolean().nullable(), // spot_the_mistake only
  unambiguous: z.boolean(),
  issues: z.array(z.string().max(300)).max(10),
});

// No length limits here: long strings are trimmed by the grader code instead
// of failing validation.
export const GraderSchema = z.object({
  key_point_results: z.array(
    z.object({
      point: z.string(),
      hit: z.boolean(),
      evidence: z.string(),
    }),
  ),
  mistake_type: MistakeType,
  mixed_up_with: z.string().nullable(),
  feedback: z.string(),
  grader_confidence: z.enum(["high", "low"]),
});

// Tiny schema used by scripts/check-setup.ts.
export const PingSchema = z.object({ ok: z.boolean() });

// ---------- Study notes (per topic) ----------

export const StudyNotesSchema = z.object({
  overview: z.string(),
  sections: z
    .array(
      z.object({
        heading: z.string(),
        points: z.array(z.object({ text: z.string(), pages: z.array(page).min(1) })).min(1).max(8),
      }),
    )
    .min(1)
    .max(6),
  key_terms: z.array(z.object({ term: z.string(), meaning: z.string(), page })).max(10),
  watch_out: z.array(z.object({ text: z.string(), page })).max(4),
});
export type StudyNotes = z.infer<typeof StudyNotesSchema>;
