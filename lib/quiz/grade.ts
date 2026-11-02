import "server-only";
import { z } from "zod";
import { callJSON, models } from "@/lib/ai/openrouter";
import {
  Confidence,
  GraderSchema,
  LIMITS,
  QuestionPrivateSchema,
  type QuizFormat,
} from "@/lib/ai/schemas";
import { gradeSystemPrompt, gradeUserPrompt } from "@/lib/ai/prompts/grade";
import { UserFacingError } from "@/lib/http";
import { applyAttempt, verdictFromScore, type Verdict } from "@/lib/mastery";
import { comebackFormat, FORMATS } from "@/lib/quiz/formats";
import { logSafetyEvent } from "@/lib/safety/events";
import { neutralizeDelimiters, sanitizeText, scanForInjection, wrapNotes, wrapStudentText } from "@/lib/safety/injection";
import { spendLLMCalls } from "@/lib/safety/limits";
import { detectSelfHarm, WELLBEING_KEYWORD_MESSAGE } from "@/lib/safety/wellbeing";
import type { UserContext } from "@/lib/db/context";
import type { GradeResponse } from "@/lib/quiz/types";

const MIN_ANSWER_CHARS = 3;
const GRADE_NOTES_CHARS = 10_000;

// ---------- Request parsing (deterministic) ----------

const GradeRequestSchema = z.object({
  questionId: z.uuid(),
  answer: z.string().max(LIMITS.maxAnswerChars),
  confidence: Confidence,
  hintUsed: z.boolean().default(false),
});
export type GradeRequest = z.infer<typeof GradeRequestSchema>;

export function parseGradeRequest(
  body: unknown,
): { ok: true; data: GradeRequest } | { ok: false; message: string } {
  const a = body && typeof body === "object" && "answer" in body ? body.answer : undefined;
  if (typeof a === "string" && a.length > LIMITS.maxAnswerChars) {
    return {
      ok: false,
      message: `Answers can be up to ${LIMITS.maxAnswerChars.toLocaleString()} characters. Try to keep it focused on the key ideas.`,
    };
  }
  if (body && typeof body === "object" && !("confidence" in body && body.confidence)) {
    return { ok: false, message: "Pick how confident you are before checking your answer." };
  }
  const parsed = GradeRequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, message: "That answer didn't look right. Please try again." };
  return { ok: true, data: parsed.data };
}

// ---------- Result sent to the browser (after submitting, so keys are OK) ----------
// Shape lives in lib/quiz/types.ts (browser-safe).

export type GradeResult = GradeResponse;

type PrivatePayload = z.infer<typeof QuestionPrivateSchema>;

function whatHappened(mistake: string, mixedUpWith: string | null): string | null {
  switch (mistake) {
    case "mixed_up":
      return mixedUpWith ? `You mixed this up with ${mixedUpWith}.` : "You mixed up two related ideas.";
    case "misconception":
      return "There's a misunderstanding about how this works — compare your answer with the notes.";
    case "incomplete":
      return "You were on the right track, but part of the answer was missing.";
    case "careless_slip":
      return "You clearly get the idea — a small detail just slipped.";
    default:
      return null;
  }
}

export async function gradeAnswer(ctx: UserContext, req: GradeRequest): Promise<GradeResult> {
  // Ownership check with the user-scoped client (RLS).
  const { data: question, error } = await ctx.db
    .from("questions")
    .select("id, course_id, topic_id, format, level, public_payload, source_pages")
    .eq("id", req.questionId)
    .maybeSingle();
  if (error) throw error;
  if (!question) throw new UserFacingError("We couldn't find that question.", 404);

  const { count: already } = await ctx.db
    .from("attempts")
    .select("id", { count: "exact", head: true })
    .eq("question_id", question.id);
  if ((already ?? 0) > 0) throw new UserFacingError("You've already answered this question.", 409);

  const format = question.format as QuizFormat;
  const answer = sanitizeText(req.answer);

  if (format !== "mcq") {
    // Wellbeing pre-check on free text: show support instead of grading.
    if (detectSelfHarm(answer)) {
      await logSafetyEvent(ctx.db, {
        type: "wellbeing_support",
        courseId: question.course_id,
        detail: { source: "quiz_answer", trigger: "keyword" },
      });
      return { kind: "wellbeing", message: WELLBEING_KEYWORD_MESSAGE };
    }
    // Instruction-like answers are graded normally; just log that we saw it.
    const scan = scanForInjection(answer);
    if (scan.flagged) {
      await logSafetyEvent(ctx.db, {
        type: "injection_flagged",
        courseId: question.course_id,
        detail: { source: "answer", question_id: question.id, patterns: scan.patterns },
      });
    }
  }

  // Answer key: never sent to the browser; read only here, scoped to this user.
  const { data: keyRow, error: keyError } = await ctx.db
    .from("question_keys")
    .select("user_id, private_payload")
    .eq("question_id", question.id)
    .maybeSingle();
  if (keyError) throw keyError;
  if (!keyRow || keyRow.user_id !== ctx.userId) throw new UserFacingError("We couldn't find that question.", 404);
  const key = keyRow.private_payload as PrivatePayload;
  const keyPoints = key.key_points;
  const options = (question.public_payload as { options: string[] | null }).options;

  let hitsList: boolean[];
  let evidence: string[] = keyPoints.map(() => "");
  let mistakeType = "none";
  let mixedUpWith: string | null = null;
  let feedback: string;
  let graderConfidence: "high" | "low" = "high";
  let chosenOption: number | null = null;
  let storedAnswer = answer;

  if (format === "mcq") {
    // Deterministic, no LLM call.
    chosenOption = Number.parseInt(req.answer, 10);
    if (!options || !Number.isInteger(chosenOption) || chosenOption < 0 || chosenOption >= options.length) {
      throw new UserFacingError("Pick one of the options first.");
    }
    storedAnswer = options[chosenOption];
    const correct = chosenOption === key.correct_option;
    hitsList = keyPoints.map(() => correct);
    // Drop a leading "Correct." from the stored reason; the card already says so.
    const details = (key.option_details ?? []).map((d) => ({
      ...d,
      why: d.why.replace(/^\s*(correct|right)[.!:—-]*\s*/i, ""),
    }));
    const right = key.correct_option ?? 0;
    if (correct) {
      feedback = details[right]?.why ?? "That's right!";
    } else {
      mistakeType = "mixed_up";
      mixedUpWith = details[chosenOption]?.concept ?? null;
      feedback = `${details[chosenOption]?.why ?? ""} The right answer is “${options[right]}”: ${details[right]?.why ?? ""}`.trim();
    }
  } else if (answer.trim().length < MIN_ANSWER_CHARS) {
    hitsList = keyPoints.map(() => false);
    mistakeType = "incomplete";
    feedback = "Give it a go in your own words — even a rough answer helps your brain learn!";
  } else {
    const graded = await gradeFreeText(ctx, question.course_id, question, format, key, answer);
    hitsList = graded.key_point_results.map((r) => r.hit);
    evidence = graded.key_point_results.map((r) => r.evidence.slice(0, 300));
    mistakeType = graded.mistake_type;
    mixedUpWith = graded.mixed_up_with ? graded.mixed_up_with.slice(0, 120) : null;
    feedback = graded.feedback.slice(0, 600);
    graderConfidence = graded.grader_confidence;
  }

  // Score is computed here, never taken from the model.
  const hits = hitsList.filter(Boolean).length;
  const total = keyPoints.length;
  const score = total > 0 ? hits / total : 0;
  const verdict = verdictFromScore(score);
  if (verdict === "correct") mistakeType = "none";
  else if (mistakeType === "none") mistakeType = "incomplete";

  const keyPointResults = keyPoints.map((k, i) => ({ point: k.point, page: k.page, hit: hitsList[i], evidence: evidence[i] }));
  const missedPages = [...new Set(keyPoints.filter((_, i) => !hitsList[i]).map((k) => k.page))].sort((a, b) => a - b);
  const somethingMissed = hits < total;

  const { error: attemptError } = await ctx.db.from("attempts").insert({
    question_id: question.id,
    course_id: question.course_id,
    topic_id: question.topic_id,
    answer: storedAnswer,
    confidence: req.confidence,
    hint_used: req.hintUsed,
    verdict,
    score,
    key_point_results: keyPointResults,
    mistake_type: mistakeType,
    feedback: { text: feedback, mixed_up_with: mixedUpWith, grader_confidence: graderConfidence },
  });
  if (attemptError) throw attemptError;

  const mastery = await updateMastery(ctx, question.topic_id, {
    verdict,
    confidence: req.confidence,
    questionLevel: question.level,
  });

  return {
    kind: "graded",
    format,
    verdict,
    score,
    hits,
    total,
    key_points: keyPointResults.map(({ point, page, hit }) => ({ point, page, hit })),
    mistake_type: mistakeType,
    mixed_up_with: mixedUpWith,
    feedback,
    what_happened: verdict === "correct" ? null : whatHappened(mistakeType, mixedUpWith),
    very_sure_warning: req.confidence === "very_sure" && verdict !== "correct",
    reread_pages: missedPages,
    low_confidence_page: graderConfidence === "low" ? (keyPoints[0]?.page ?? null) : null,
    comeback_format_label: somethingMissed ? FORMATS[comebackFormat(format)].label : null,
    reveal: {
      model_answer: key.model_answer,
      correct_option: key.correct_option,
      chosen_option: chosenOption,
      original_statement: key.original_statement,
    },
    mastery: { ...mastery, topic_id: question.topic_id },
  };
}

async function gradeFreeText(
  ctx: UserContext,
  courseId: string,
  question: { public_payload: unknown; source_pages: number[] },
  format: QuizFormat,
  key: PrivatePayload,
  answer: string,
) {
  const { data: pages, error } = await ctx.db
    .from("pages")
    .select("page_number, text")
    .eq("course_id", courseId)
    .in("page_number", question.source_pages)
    .order("page_number");
  if (error) throw error;
  const perPage = Math.max(500, Math.floor(GRADE_NOTES_CHARS / Math.max(1, pages?.length ?? 1)));
  const notesBlock = wrapNotes(
    (pages ?? []).map((p) => ({ page: p.page_number as number, text: (p.text as string).slice(0, perPage) })),
  );

  const n = key.key_points.length;
  const schema = GraderSchema.extend({
    key_point_results: z
      .array(z.object({ point: z.string(), hit: z.boolean(), evidence: z.string() }))
      .length(n),
  });

  const pub = question.public_payload as { question_markdown: string };
  await spendLLMCalls({ ...ctx, courseId });
  return callJSON({
    model: models.professor(),
    system: gradeSystemPrompt(n),
    user: gradeUserPrompt({
      question: neutralizeDelimiters(pub.question_markdown),
      formatLine: `${format} (${FORMATS[format].label})`,
      keyPoints: key.key_points,
      modelAnswer: key.model_answer,
      extra: key.original_statement
        ? `Original true statement (p. ${key.original_statement.page}): ${key.original_statement.text}`
        : null,
      notesBlock,
      answerBlock: wrapStudentText("student_answer", answer),
    }),
    schema,
    temperature: 0,
    name: "grading",
  });
}

async function updateMastery(
  ctx: UserContext,
  topicId: string,
  attempt: { verdict: Verdict; confidence: z.infer<typeof Confidence>; questionLevel: number },
) {
  const [{ data: topic, error }, { data: recent, error: recentError }] = await Promise.all([
    ctx.db.from("topics").select("mastery_level, level_progress, danger_zone").eq("id", topicId).single(),
    ctx.db
      .from("attempts")
      .select("verdict")
      .eq("topic_id", topicId)
      .order("created_at", { ascending: false })
      .limit(2),
  ]);
  if (error) throw error;
  if (recentError) throw recentError;

  const next = applyAttempt(topic, {
    ...attempt,
    recentVerdicts: (recent ?? []).map((r) => r.verdict as Verdict),
  });
  const { error: updateError } = await ctx.db
    .from("topics")
    .update({
      mastery_level: next.mastery_level,
      level_progress: next.level_progress,
      danger_zone: next.danger_zone,
      last_practiced_at: new Date().toISOString(),
    })
    .eq("id", topicId);
  if (updateError) throw updateError;
  return { level: next.mastery_level, leveled_up: next.leveledUp, danger_zone: next.danger_zone };
}
