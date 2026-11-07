"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FeedbackCard } from "@/components/FeedbackCard";
import { PageModal } from "@/components/PageModal";
import { QuestionCard, type AnswerDraft } from "@/components/QuestionCard";
import { InjectionBanner, WellbeingCard } from "@/components/SafetyCards";
import { Loading, LoadingCard } from "@/components/Spinner";
import type { QuizFormat } from "@/lib/ai/schemas";
import { announce, getJSON, isHandledApiError, postJSON, type CourseResponse } from "@/lib/api-client";
import { levelLabel, pageRange } from "@/lib/mastery";
import { FORMAT_ORDER, FORMATS } from "@/lib/quiz/formats";
import type { GradedResult, GradeResponse, PublicQuestion } from "@/lib/quiz/types";
import { useSession } from "@/lib/session";

const SESSION_LENGTH = 5;
// How many questions to keep ready ahead of the current one.
const READY_AHEAD = 2;

type Topic = { id: string; name: string; page_start: number; page_end: number; mastery_level: number; danger_zone: boolean };
type TopicChoice = "mix" | "weak" | string;
type FormatChoice = QuizFormat | "surprise";

type Phase =
  | { kind: "setup" }
  | { kind: "waiting" }
  | { kind: "question"; q: PublicQuestion }
  | { kind: "grading"; q: PublicQuestion }
  | { kind: "feedback"; q: PublicQuestion; result: GradedResult }
  | { kind: "wellbeing"; q: PublicQuestion; message: string }
  | { kind: "summary" }
  | { kind: "error"; message: string; retry: "next" | "grade"; q?: PublicQuestion };

type Answered = { topic: PublicQuestion["topic"]; verdict: GradedResult["verdict"] };

const emptyDraft: AnswerDraft = { option: null, text: "", confidence: null, hintShown: false };

// Next.js keeps visited pages alive (React Activity), so without a key the
// previous round would reappear. Reset on every link navigation and whenever
// the ?topic= changes; browser back/forward still restores the round.
export function QuizClient() {
  const router = useRouter();
  const search = useSearchParams();
  return <QuizSession key={`${router.bfcacheId}|${search.toString()}`} initialTopic={search.get("topic")} />;
}

function QuizSession({ initialTopic }: { initialTopic: string | null }) {
  const { id: courseId } = useParams<{ id: string }>();
  const session = useSession();
  const [course, setCourse] = useState<{ name: string; flagged_pages: number[] } | null | "missing" | "error">(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicChoice, setTopicChoice] = useState<TopicChoice>(() => {
    if (initialTopic === "weak") return "weak";
    return initialTopic && /^[0-9a-f-]{36}$/i.test(initialTopic) ? initialTopic : "mix";
  });
  const [formatChoice, setFormatChoice] = useState<FormatChoice>("surprise");
  const [phase, setPhase] = useState<Phase>({ kind: "setup" });
  const [draft, setDraft] = useState<AnswerDraft>(emptyDraft);
  const [answered, setAnswered] = useState<Answered[]>([]);
  const [openPage, setOpenPage] = useState<{ page: number; range?: [number, number] } | null>(null);
  const [readyCount, setReadyCount] = useState(0); // mirrors queue length for rendering

  // Question pipeline (mutable; survives re-renders).
  const queue = useRef<PublicQuestion[]>([]);
  const inflight = useRef(0);
  const generating = useRef(false);
  const waiting = useRef(false);
  const round = useRef(0);
  const current = useRef<PublicQuestion | null>(null);
  const answeredCount = useRef(0);

  useEffect(() => {
    if (session !== "ready") return;
    getJSON<CourseResponse>(`/api/courses/${courseId}`).then(({ course, topics }) => {
      if (!course) setCourse("missing");
      else {
        setCourse(course as { name: string; flagged_pages: number[] });
        setTopics(topics as Topic[]);
      }
    }, () => setCourse("error"));
  }, [session, courseId]);

  const refresh = () => setReadyCount(queue.current.length);
  const planned = () => answeredCount.current + (current.current ? 1 : 0) + queue.current.length + inflight.current;
  const mixed = topicChoice === "mix" || topicChoice === "weak";

  function requestNext(topic: string, avoidTopicIds: string[]): Promise<PublicQuestion> {
    // Quiet: questions are generated ahead in the background; a limit hit is shown only
    // when the student is actually waiting for the next question (pump's error path).
    return postJSON<PublicQuestion>("/api/quiz/next", { courseId, topic, format: formatChoice, avoidTopicIds }, { quiet: true });
  }

  function show(q: PublicQuestion) {
    current.current = q;
    waiting.current = false;
    setDraft(emptyDraft);
    setPhase({ kind: "question", q });
    pump();
  }

  function enqueue(q: PublicQuestion, at?: number) {
    if (at === undefined) queue.current.push(q);
    else queue.current.splice(Math.min(at, queue.current.length), 0, q);
    if (waiting.current) show(queue.current.shift()!);
    refresh();
  }

  // Keep up to READY_AHEAD questions ready, one generation at a time (so new
  // questions can see the previous ones and don't repeat them).
  function pump() {
    if (generating.current || queue.current.length >= READY_AHEAD || planned() >= SESSION_LENGTH) return;
    const r = round.current;
    generating.current = true;
    inflight.current++;
    refresh();
    const avoid = mixed
      ? [current.current?.topic.id, ...queue.current.map((q) => q.topic.id)].filter((x): x is string => !!x)
      : [];
    requestNext(topicChoice, avoid).then(
      (q) => {
        if (r !== round.current) return;
        generating.current = false;
        inflight.current--;
        enqueue(q);
        pump();
      },
      (err) => {
        if (r !== round.current) return;
        generating.current = false;
        inflight.current--;
        refresh();
        // Only interrupt the student if they're actually waiting for it.
        if (waiting.current && queue.current.length === 0 && inflight.current === 0) {
          if (isHandledApiError(err)) announce(err);
          setPhase({ kind: "error", message: err instanceof Error ? err.message : "Something went wrong.", retry: "next" });
        }
      },
    );
  }

  // A missed answer brings that topic back in a different format. It's
  // generated in the background and slotted in after the next ready question.
  function requestComeback(topicId: string) {
    if (answeredCount.current >= SESSION_LENGTH) return;
    if (planned() >= SESSION_LENGTH) {
      if (queue.current.length > 1) queue.current.pop();
      else return;
    }
    const r = round.current;
    inflight.current++;
    requestNext(topicId, []).then(
      (q) => {
        if (r !== round.current) return;
        inflight.current--;
        enqueue(q, 1);
      },
      () => {
        if (r !== round.current) return;
        inflight.current--;
        pump();
      },
    );
  }

  function next() {
    current.current = null;
    if (answeredCount.current >= SESSION_LENGTH) {
      setPhase({ kind: "summary" });
      return;
    }
    const q = queue.current.shift();
    if (q) {
      show(q);
    } else {
      waiting.current = true;
      setPhase({ kind: "waiting" });
      pump();
    }
    refresh();
  }

  function startRound() {
    round.current++;
    queue.current = [];
    inflight.current = 0;
    generating.current = false;
    current.current = null;
    answeredCount.current = 0;
    setAnswered([]);
    next();
  }

  function endRound() {
    round.current++; // ignore anything still being generated
    queue.current = [];
    inflight.current = 0;
    generating.current = false;
    waiting.current = false;
    current.current = null;
    setPhase(answeredCount.current > 0 ? { kind: "summary" } : { kind: "setup" });
  }

  async function submit(q: PublicQuestion) {
    if (!draft.confidence) return;
    setPhase({ kind: "grading", q });
    try {
      const res = await postJSON<GradeResponse>("/api/quiz/grade", {
        questionId: q.questionId,
        answer: q.format === "mcq" ? String(draft.option) : draft.text,
        confidence: draft.confidence,
        hintUsed: draft.hintShown,
      });
      if (res.kind === "wellbeing") {
        setPhase({ kind: "wellbeing", q, message: res.message });
        return;
      }
      answeredCount.current += 1;
      current.current = null; // now counted in answeredCount, not as "current"
      setAnswered((a) => [...a, { topic: q.topic, verdict: res.verdict }]);
      setTopics((ts) =>
        ts.map((t) =>
          t.id === res.mastery.topic_id ? { ...t, mastery_level: res.mastery.level, danger_zone: res.mastery.danger_zone } : t,
        ),
      );
      setPhase({ kind: "feedback", q, result: res });
      if (res.hits < res.total) requestComeback(res.mastery.topic_id);
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : "Something went wrong.", retry: "grade", q });
    }
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
  const done = answered.length;
  const inRound = phase.kind !== "setup" && phase.kind !== "summary";
  const nextReady = readyCount > 0;

  return (
    <div className="space-y-4">
      <div>
        <Link href={base} className="text-sm text-indigo-700 hover:underline">
          ← {course?.name ?? "Course"}
        </Link>
        <div className="mt-1 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">🎯 Quiz Mode</h1>
            <p className="text-slate-700">Test yourself before the real exam does.</p>
          </div>
          {inRound && (
            <button
              onClick={endRound}
              className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
            >
              ⏹ End quiz
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-600">📚 Practice — at your own pace, hints on, no timer.</p>
      </div>

      {course && <InjectionBanner pages={course.flagged_pages ?? []} />}

      {inRound && (
        <div className="flex items-center gap-1" aria-label={`${done} of ${SESSION_LENGTH} answered`}>
          {Array.from({ length: SESSION_LENGTH }).map((_, i) => (
            <span
              key={i}
              className={`h-2 flex-1 rounded-full ${
                i < done
                  ? answered[i].verdict === "correct"
                    ? "bg-emerald-500"
                    : answered[i].verdict === "partial"
                      ? "bg-amber-400"
                      : "bg-rose-400"
                  : i === done
                    ? "bg-indigo-300"
                    : "bg-slate-200"
              }`}
            />
          ))}
        </div>
      )}

      {phase.kind === "setup" && (
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          {!course ? (
            <Loading message="Loading your topics…" />
          ) : topics.length === 0 ? (
            <p className="text-sm text-slate-700">This course has no topics yet, so there&apos;s nothing to quiz on.</p>
          ) : (
            <>
              <fieldset>
                <legend className="font-semibold text-slate-900">What should we practise?</legend>
                <div className="mt-2 grid gap-2">
                  {[
                    { value: "mix", label: "🔀 Mix it up", sub: "Weakest topics first" },
                    { value: "weak", label: "🩹 Review my weak spots", sub: "Danger zones and recent misses" },
                  ].map((o) => (
                    <ChoiceButton key={o.value} active={topicChoice === o.value} onClick={() => setTopicChoice(o.value)}>
                      <span className="font-medium">{o.label}</span>
                      <span className="block text-xs text-slate-500">{o.sub}</span>
                    </ChoiceButton>
                  ))}
                  <label htmlFor="topic-select" className="sr-only">
                    Or pick a topic
                  </label>
                  <select
                    id="topic-select"
                    value={mixed ? "" : topicChoice}
                    onChange={(e) => e.target.value && setTopicChoice(e.target.value)}
                    className={`rounded-xl border px-3 py-2.5 text-sm ${
                      !mixed ? "border-indigo-600 bg-indigo-50 text-slate-900" : "border-slate-300 bg-white text-slate-700"
                    }`}
                  >
                    <option value="">📖 Or pick one topic…</option>
                    {topics.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.danger_zone ? "⚠️ " : ""}
                        {t.name} — {levelLabel(t.mastery_level)}
                      </option>
                    ))}
                  </select>
                </div>
              </fieldset>

              <fieldset>
                <legend className="font-semibold text-slate-900">Question type</legend>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <ChoiceButton active={formatChoice === "surprise"} onClick={() => setFormatChoice("surprise")}>
                    <span className="font-medium">🎲 Surprise me</span>
                    <span className="block text-xs text-slate-500">Matched to your level</span>
                  </ChoiceButton>
                  {FORMAT_ORDER.map((f) => (
                    <ChoiceButton key={f} active={formatChoice === f} onClick={() => setFormatChoice(f)}>
                      <span className="font-medium">{FORMATS[f].label}</span>
                      <span className="block text-xs text-slate-500">
                        {FORMATS[f].blurb} · {levelLabel(FORMATS[f].level)}
                      </span>
                    </ChoiceButton>
                  ))}
                </div>
              </fieldset>

              <button
                onClick={startRound}
                disabled={session !== "ready"}
                className="w-full rounded-xl bg-emerald-700 px-4 py-3 font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                Start a {SESSION_LENGTH}-question round
              </button>
            </>
          )}
        </div>
      )}

      {phase.kind === "waiting" && (
        <LoadingCard
          messages={[
            `Writing question ${done + 1}…`,
            "Double-checking it against your notes…",
            "Making sure there's exactly one right answer…",
            "Almost ready…",
          ]}
          sub={
            done === 0
              ? "The first question takes up to half a minute. The next ones are prepared while you answer."
              : "Preparing your next question…"
          }
        />
      )}

      {(phase.kind === "question" || phase.kind === "grading") && (
        <QuestionCard
          question={phase.q}
          number={done + 1}
          total={SESSION_LENGTH}
          draft={draft}
          onDraft={setDraft}
          onSubmit={() => void submit(phase.q)}
          submitting={phase.kind === "grading"}
        />
      )}

      {phase.kind === "feedback" && (
        <>
          <QuestionCard
            question={phase.q}
            number={done}
            total={SESSION_LENGTH}
            draft={draft}
            onDraft={() => {}}
            onSubmit={() => {}}
            submitting={false}
            readOnly
          />
          <FeedbackCard result={phase.result} question={phase.q} onOpenPage={(page) => setOpenPage({ page })} />
          {done >= SESSION_LENGTH ? (
            <button
              onClick={() => setPhase({ kind: "summary" })}
              className="w-full rounded-xl bg-indigo-700 px-4 py-3 font-semibold text-white hover:bg-indigo-800"
            >
              See how you did →
            </button>
          ) : (
            <div className="space-y-1">
              <button
                onClick={next}
                className="w-full rounded-xl bg-indigo-700 px-4 py-3 font-semibold text-white hover:bg-indigo-800"
              >
                Next question →
              </button>
              <div className="flex items-center justify-center gap-2 text-xs text-slate-500">
                {nextReady ? "✅ Your next question is ready" : <Loading message="Preparing your next question…" />}
              </div>
            </div>
          )}
        </>
      )}

      {phase.kind === "wellbeing" && (
        <>
          <WellbeingCard message={phase.message} />
          <button
            onClick={() => setPhase({ kind: "question", q: phase.q })}
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 font-semibold text-slate-800 hover:bg-slate-50"
          >
            Back to the question when you&apos;re ready
          </button>
        </>
      )}

      {phase.kind === "summary" && (
        <SessionSummary
          answered={answered}
          onOpenRange={(t) => setOpenPage({ page: t.page_start, range: [t.page_start, t.page_end] })}
          onAgain={startRound}
          onChange={() => setPhase({ kind: "setup" })}
          progressHref={`${base}/progress`}
        />
      )}

      {phase.kind === "error" && (
        <div role="alert" className="space-y-3 rounded-2xl bg-red-50 p-4 text-sm text-red-800">
          <p>{phase.message}</p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => (phase.retry === "grade" && phase.q ? void submit(phase.q) : next())}
              className="rounded-lg bg-red-700 px-3 py-1.5 font-semibold text-white hover:bg-red-800"
            >
              Try again
            </button>
            <button
              onClick={endRound}
              className="rounded-lg border border-red-300 px-3 py-1.5 font-medium text-red-800 hover:bg-red-100"
            >
              End quiz
            </button>
          </div>
        </div>
      )}

      {openPage && (
        <PageModal courseId={courseId} page={openPage.page} range={openPage.range} onClose={() => setOpenPage(null)} />
      )}
    </div>
  );
}

function ChoiceButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-xl border px-3 py-2.5 text-left text-sm transition ${
        active ? "border-indigo-600 bg-indigo-50 text-slate-900" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

function SessionSummary({
  answered,
  onOpenRange,
  onAgain,
  onChange,
  progressHref,
}: {
  answered: Answered[];
  onOpenRange: (t: PublicQuestion["topic"]) => void;
  onAgain: () => void;
  onChange: () => void;
  progressHref: string;
}) {
  const correct = answered.filter((a) => a.verdict === "correct").length;
  // Focus on the topic with the most misses this round.
  const misses = new Map<string, { topic: PublicQuestion["topic"]; n: number }>();
  for (const a of answered) {
    if (a.verdict === "correct") continue;
    const m = misses.get(a.topic.id) ?? { topic: a.topic, n: 0 };
    m.n += a.verdict === "incorrect" ? 2 : 1;
    misses.set(a.topic.id, m);
  }
  const focus = [...misses.values()].sort((a, b) => b.n - a.n)[0]?.topic;

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 shadow-sm">
      <p className="text-3xl" aria-hidden>
        {answered.length > 0 && correct === answered.length ? "🏆" : "🦉"}
      </p>
      <p className="text-lg font-bold">
        You answered {correct}/{answered.length} correctly.
      </p>
      {focus ? (
        <p>
          Focus on {focus.name}{" "}
          <button onClick={() => onOpenRange(focus)} className="font-semibold text-indigo-800 underline">
            ({pageRange(focus.page_start, focus.page_end)})
          </button>
          .
        </p>
      ) : answered.length > 0 ? (
        <p>Brilliant — every answer was spot on! 🎉</p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          onClick={onAgain}
          className="flex-1 rounded-xl bg-emerald-700 px-4 py-2.5 font-semibold text-white hover:bg-emerald-800"
        >
          Another round
        </button>
        <button
          onClick={onChange}
          className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 font-semibold text-slate-800 hover:bg-slate-50"
        >
          Change topic or type
        </button>
        <Link
          href={progressHref}
          className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-center font-semibold text-slate-800 hover:bg-slate-50"
        >
          📈 My progress
        </Link>
      </div>
    </div>
  );
}
