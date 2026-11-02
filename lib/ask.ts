import "server-only";
import { z } from "zod";
import { callJSON, models } from "@/lib/ai/openrouter";
import { AskResponseSchema, GeneralAnswerSchema, LIMITS, type AskStatus } from "@/lib/ai/schemas";
import {
  askSystemPrompt,
  askUserPrompt,
  generalSystemPrompt,
  generalUserPrompt,
  type FollowUp,
} from "@/lib/ai/prompts/ask";
import { retrieveChunks } from "@/lib/rag/retrieve";
import { stripCitations, validateCitations } from "@/lib/safety/citations";
import { logSafetyEvent } from "@/lib/safety/events";
import { sanitizeText, wrapConversation, wrapNotes, wrapStudentText } from "@/lib/safety/injection";
import { spendLLMCalls } from "@/lib/safety/limits";
import { detectSelfHarm, WELLBEING_KEYWORD_MESSAGE } from "@/lib/safety/wellbeing";
import { UserFacingError } from "@/lib/http";
import type { UserContext } from "@/lib/db/context";

// ---------- Request parsing (deterministic, used by the route and evals) ----------

const HistoryItem = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().transform((s) => s.slice(0, LIMITS.maxAnswerChars)),
});

const AskRequestSchema = z.object({
  courseId: z.uuid(),
  question: z.string().trim().min(1).max(LIMITS.maxQuestionChars),
  history: z.array(HistoryItem).default([]).transform((h) => h.slice(-LIMITS.chatHistoryMessages)),
  followUp: z.enum(["simpler", "example", "why"]).nullable().default(null),
  mode: z.enum(["grounded", "general"]).default("grounded"),
});

export type AskRequest = z.infer<typeof AskRequestSchema>;

export function parseAskRequest(
  body: unknown,
): { ok: true; data: AskRequest } | { ok: false; message: string } {
  const q = body && typeof body === "object" && "question" in body ? body.question : undefined;
  if (typeof q === "string" && q.trim().length > LIMITS.maxQuestionChars) {
    return {
      ok: false,
      message: `Questions can be up to ${LIMITS.maxQuestionChars.toLocaleString()} characters. Try asking about one idea at a time.`,
    };
  }
  if (typeof q === "string" && q.trim().length === 0) {
    return { ok: false, message: "Type a question first." };
  }
  const parsed = AskRequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, message: "That question didn't look right. Please try again." };
  return { ok: true, data: parsed.data };
}

// ---------- Ask ----------

export type AskResult = {
  status: AskStatus;
  answer_markdown: string;
  cited_pages: number[];
  general: boolean; // true = "Explain anyway" general-knowledge answer
  note: string | null; // deterministic extra line for not_in_notes
};

const PAGE_REF = /\b(?:page|pg|p\.)\s*(\d{1,4})\b/gi;

function notInNotes(note: string | null = null): AskResult {
  return { status: "not_in_notes", answer_markdown: "", cited_pages: [], general: false, note };
}

async function logStatus(ctx: UserContext, courseId: string, status: AskStatus, general: boolean) {
  if (status === "integrity_boundary" || status === "wellbeing_support" || status === "unsafe_request") {
    await logSafetyEvent(ctx.db, {
      type: status,
      courseId,
      detail: { source: general ? "ask_general" : "ask", trigger: "model" },
    });
  }
}

export async function askProfessor(ctx: UserContext, req: AskRequest): Promise<AskResult> {
  const question = sanitizeText(req.question);

  // 1. Wellbeing pre-check: forces the support card and skips the normal answer.
  if (detectSelfHarm(question)) {
    await logSafetyEvent(ctx.db, {
      type: "wellbeing_support",
      courseId: req.courseId,
      detail: { source: "ask", trigger: "keyword" },
    });
    return {
      status: "wellbeing_support",
      answer_markdown: WELLBEING_KEYWORD_MESSAGE,
      cited_pages: [],
      general: false,
      note: null,
    };
  }

  const { data: course, error } = await ctx.db
    .from("courses")
    .select("id, page_count")
    .eq("id", req.courseId)
    .maybeSingle();
  if (error) throw error;
  if (!course) throw new UserFacingError("We couldn't find that course.", 404);

  const history = req.history.map((m) => ({ role: m.role, content: sanitizeText(m.content) }));
  const conversationBlock = history.length > 0 ? wrapConversation(history) : null;
  const questionBlock = wrapStudentText("student_question", question);

  if (req.mode === "general") return generalAnswer(ctx, req.courseId, conversationBlock, questionBlock);

  // Pages the student named explicitly. A page that doesn't exist is never invented.
  const named = [...question.matchAll(PAGE_REF)].map((m) => Number(m[1]));
  const missing = named.filter((p) => p < 1 || p > course.page_count);
  if (missing.length > 0) {
    return notInNotes(
      `Your notes only have ${course.page_count} page${course.page_count === 1 ? "" : "s"}, so there's no page ${missing[0]}.`,
    );
  }

  // 2–3. Embed the question and retrieve the top chunks.
  const chunks = await retrieveChunks(ctx, req.courseId, question, { count: 6, extraPages: named });
  if (chunks.length === 0) return notInNotes();
  const retrievedPages = [...new Set(chunks.map((c) => c.page_number))];
  const notesBlock = wrapNotes(
    [...chunks]
      .sort((a, b) => a.page_number - b.page_number)
      .map((c) => ({ page: c.page_number, text: c.content })),
  );

  // 4. Grounded answer.
  const call = async (citationFix?: string) => {
    await spendLLMCalls({ ...ctx, courseId: req.courseId });
    return callJSON({
      model: models.professor(),
      system: askSystemPrompt(),
      user: askUserPrompt({
        notesBlock,
        conversationBlock,
        questionBlock,
        followUp: req.followUp as FollowUp | null,
        citationFix,
      }),
      schema: AskResponseSchema,
      temperature: 0.3,
      name: "ask_answer",
    });
  };

  let out = await call();
  if (out.status === "answered") {
    let check = validateCitations(out, retrievedPages);
    if (!check.ok) {
      const firstProblems = check.problems;
      out = await call(check.message);
      check = out.status === "answered" ? validateCitations(out, retrievedPages) : { ok: true };
      if (!check.ok) {
        await logSafetyEvent(ctx.db, {
          type: "citation_invalid",
          courseId: req.courseId,
          detail: {
            problems: [...new Set([...firstProblems, ...check.problems])],
            cited: out.cited_pages,
            retrieved: retrievedPages,
          },
        });
        return notInNotes();
      }
    }
  }

  await logStatus(ctx, req.courseId, out.status, false);
  if (out.status === "not_in_notes") return notInNotes();
  return {
    status: out.status,
    answer_markdown: out.status === "answered" ? out.answer_markdown : stripCitations(out.answer_markdown),
    cited_pages: out.status === "answered" ? [...new Set(out.cited_pages)].sort((a, b) => a - b) : [],
    general: false,
    note: null,
  };
}

async function generalAnswer(
  ctx: UserContext,
  courseId: string,
  conversationBlock: string | null,
  questionBlock: string,
): Promise<AskResult> {
  await spendLLMCalls({ ...ctx, courseId });
  const out = await callJSON({
    model: models.professor(),
    system: generalSystemPrompt(),
    user: generalUserPrompt({ conversationBlock, questionBlock }),
    schema: GeneralAnswerSchema,
    temperature: 0.3,
    name: "general_answer",
  });
  await logStatus(ctx, courseId, out.status, true);
  // General answers never carry citations.
  return {
    status: out.status,
    answer_markdown: stripCitations(out.answer_markdown),
    cited_pages: [],
    general: out.status === "answered",
    note: null,
  };
}
