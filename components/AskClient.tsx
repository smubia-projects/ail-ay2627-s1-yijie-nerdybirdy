"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ChatMessage,
  type AskBody,
  type AssistantReply,
  type ChatItem,
} from "@/components/ChatMessage";
import { PageModal } from "@/components/PageModal";
import { InjectionBanner } from "@/components/SafetyCards";
import { Loading } from "@/components/Spinner";
import { LIMITS } from "@/lib/ai/schemas";
import { getJSON, postJSON, type CourseResponse } from "@/lib/api-client";
import { useSession } from "@/lib/session";

type CourseInfo = { name: string; flagged_pages: number[] };

let nextId = 0;
const newId = () => `m${++nextId}`;

export function AskClient() {
  const { id: courseId } = useParams<{ id: string }>();
  const session = useSession();
  const [course, setCourse] = useState<CourseInfo | null | "missing" | "error">(null);
  const [topics, setTopics] = useState<string[]>([]);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [openPage, setOpenPage] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (session !== "ready") return;
    getJSON<CourseResponse>(`/api/courses/${courseId}`).then(
      ({ course, topics }) => {
        if (!course) setCourse("missing");
        else setCourse(course as CourseInfo);
        setTopics(topics.slice(0, 3).map((x) => x.name as string));
      },
      () => setCourse("error"),
    );
  }, [session, courseId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items, busy]);

  // Last 6 messages (user questions + professor answers) as context.
  function historyFor(list: ChatItem[]): { role: "user" | "assistant"; content: string }[] {
    const out: { role: "user" | "assistant"; content: string }[] = [];
    for (const m of list) {
      if (m.role === "user") out.push({ role: "user", content: m.text });
      else if (m.role === "assistant" && m.reply.answer_markdown)
        out.push({ role: "assistant", content: m.reply.answer_markdown });
    }
    return out.slice(-LIMITS.chatHistoryMessages);
  }

  async function send(label: string, body: AskBody) {
    if (busy) return;
    const history = historyFor(items);
    const userItem: ChatItem = { id: newId(), role: "user", text: label };
    setItems((prev) => [...prev.filter((m) => m.role !== "error"), userItem]);
    setBusy(true);
    try {
      const reply = await postJSON<AssistantReply>("/api/ask", { courseId, history, ...body });
      setItems((prev) => [...prev, { id: newId(), role: "assistant", question: body.question, reply }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setItems((prev) => [
        ...prev.filter((m) => m.id !== userItem.id),
        { id: newId(), role: "error", text: message, retry: { label, body } },
      ]);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    void send(q, { question: q });
  }

  if (session === "error" || course === "error") {
    return (
      <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800">
        We couldn&apos;t load this course. Please refresh the page.
      </p>
    );
  }
  if (course === "missing") {
    return (
      <p className="text-slate-700">
        We couldn&apos;t find this course.{" "}
        <Link href="/" className="font-medium text-indigo-700 underline">
          Back to home
        </Link>
      </p>
    );
  }

  const base = `/course/${courseId}`;
  const suggestions = [
    ...topics.map((t) => `Explain ${t} in simple terms`),
    "What are the most important ideas in these notes?",
  ].slice(0, 3);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={base} className="text-sm text-indigo-700 hover:underline">
          ← {course?.name ?? "Course"}
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">💬 Ask the Professor</h1>
        <p className="text-sm text-slate-600">
          Answers come only from your notes, with page numbers you can check.
        </p>
      </div>

      {course && <InjectionBanner pages={course.flagged_pages ?? []} />}

      <div className="flex flex-col gap-3" aria-live="polite">
        {items.length === 0 && (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-5 text-center text-sm text-slate-600">
            <p className="text-3xl" aria-hidden>
              🦉
            </p>
            <p className="mt-1">Ask me anything about your notes. Try:</p>
            <div className="mt-3 flex flex-col gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s, { question: s })}
                  disabled={busy || session !== "ready" || !course}
                  className="rounded-lg border border-indigo-200 px-3 py-2 text-indigo-800 hover:bg-indigo-50 disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((item) => (
          <ChatMessage
            key={item.id}
            item={item}
            busy={busy}
            quizHref={`${base}/quiz`}
            onCite={setOpenPage}
            onFollowUp={(question, followUp, label) => void send(label, { question, followUp })}
            onExplainAnyway={(question) =>
              void send("Explain anyway", { question, mode: "general" })
            }
            onRetry={(label, body) => void send(label, body)}
          />
        ))}
        {busy && <Loading message="The professor is flipping through your notes…" />}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={onSubmit}
        className="sticky bottom-0 -mx-4 border-t border-slate-200 bg-slate-50 px-4 py-3"
      >
        <label htmlFor="ask-input" className="sr-only">
          Your question
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="ask-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit(e);
              }
            }}
            maxLength={LIMITS.maxQuestionChars}
            rows={2}
            placeholder="Ask a question about your notes…"
            disabled={session !== "ready"}
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !input.trim() || session !== "ready"}
            className="rounded-xl bg-indigo-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
          >
            Ask
          </button>
        </div>
        {input.length > LIMITS.maxQuestionChars * 0.8 && (
          <p className="mt-1 text-right text-xs text-slate-500">
            {input.length}/{LIMITS.maxQuestionChars}
          </p>
        )}
      </form>

      {openPage !== null && (
        <PageModal courseId={courseId} page={openPage} onClose={() => setOpenPage(null)} />
      )}
    </div>
  );
}
