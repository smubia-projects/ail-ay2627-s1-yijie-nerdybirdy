"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { PageModal } from "@/components/PageModal";
import { Loading } from "@/components/Spinner";
import type { QuizFormat } from "@/lib/ai/schemas";
import { LEVEL_NAMES, levelLabel, orderTopicsForReview, pageRange } from "@/lib/mastery";
import { FORMATS } from "@/lib/quiz/formats";
import { getJSON, type CourseResponse } from "@/lib/api-client";
import { useSession } from "@/lib/session";

type Topic = {
  id: string;
  name: string;
  page_start: number;
  page_end: number;
  mastery_level: number;
  level_progress: number;
  danger_zone: boolean;
  last_practiced_at: string | null;
};
type Verdict = "correct" | "partial" | "incorrect";
type Confidence = "guessing" | "fairly_sure" | "very_sure";
type Attempt = {
  topic_id: string;
  verdict: Verdict;
  confidence: Confidence;
  created_at: string;
  questions: { format: QuizFormat } | null;
};

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error" }
  | { kind: "ok"; name: string; topics: Topic[]; attempts: Attempt[] };

const LAST_SESSION = 5;
const LEVEL_COLORS = ["bg-slate-200", "bg-sky-300", "bg-indigo-400", "bg-violet-500", "bg-emerald-500"];
const CONFIDENCE: { key: Confidence; label: string }[] = [
  { key: "guessing", label: "🤔 Guessing" },
  { key: "fairly_sure", label: "🙂 Fairly sure" },
  { key: "very_sure", label: "😎 Very sure" },
];
const VERDICT_ICON: Record<Verdict, string> = { correct: "✅", partial: "🟡", incorrect: "❌" };

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));

// Progress = analytics: how well you know each chapter and how calibrated
// your confidence is. (The course home is the study hub.)
export function ProgressClient() {
  const { id: courseId } = useParams<{ id: string }>();
  const session = useSession();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [openRange, setOpenRange] = useState<[number, number] | null>(null);

  useEffect(() => {
    if (session !== "ready") return;
    Promise.all([
      getJSON<CourseResponse>(`/api/courses/${courseId}`),
      getJSON<{ attempts: Attempt[] }>(`/api/courses/${courseId}/attempts`),
    ]).then(
      ([c, a]) => {
        if (!c.course) setLoad({ kind: "missing" });
        else setLoad({ kind: "ok", name: c.course.name, topics: c.topics as Topic[], attempts: a.attempts });
      },
      () => setLoad({ kind: "error" }),
    );
  }, [session, courseId]);

  if (session === "error" || load.kind === "error") {
    return (
      <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800">
        We couldn&apos;t load your progress. Please refresh the page.
      </p>
    );
  }
  if (load.kind === "loading") return <Loading message="Crunching your progress…" />;
  if (load.kind === "missing") {
    return (
      <p className="text-slate-700">
        We couldn&apos;t find this course.{" "}
        <Link href="/" className="font-medium text-indigo-700 underline">
          Back to home
        </Link>
      </p>
    );
  }

  const { topics, attempts, name } = load;
  const base = `/course/${courseId}`;
  const byId = new Map(topics.map((t) => [t.id, t]));

  // Overall mastery: share of the 4 levels reached across all chapters.
  const mastery = pct(
    topics.reduce((s, t) => s + t.mastery_level, 0),
    topics.length * 4,
  );
  const levelCounts = [0, 1, 2, 3, 4].map((l) => topics.filter((t) => t.mastery_level === l).length);
  const correct = attempts.filter((a) => a.verdict === "correct").length;
  const dangerCount = topics.filter((t) => t.danger_zone).length;

  // Per-topic accuracy.
  const perTopic = new Map<string, { n: number; correct: number }>();
  for (const a of attempts) {
    const s = perTopic.get(a.topic_id) ?? { n: 0, correct: 0 };
    s.n += 1;
    if (a.verdict === "correct") s.correct += 1;
    perTopic.set(a.topic_id, s);
  }

  // Confidence calibration.
  const calib = CONFIDENCE.map(({ key, label }) => {
    const rows = attempts.filter((a) => a.confidence === key);
    return { key, label, n: rows.length, acc: pct(rows.filter((a) => a.verdict === "correct").length, rows.length) };
  });
  const verySure = calib.find((c) => c.key === "very_sure")!;
  const guessing = calib.find((c) => c.key === "guessing")!;
  const calibInsight =
    verySure.n >= 2 && verySure.acc < 70
      ? `When you're "very sure", you're right ${verySure.acc}% of the time — slow down and double-check those answers.`
      : guessing.n >= 2 && guessing.acc >= 60
        ? `Your guesses are right ${guessing.acc}% of the time — you know more than you think!`
        : verySure.n >= 2
          ? `Nice calibration: when you're "very sure", you're right ${verySure.acc}% of the time.`
          : "Answer a few more questions to see how well your confidence matches your results.";

  // Last session = the most recent answers.
  const recent = attempts.slice(0, LAST_SESSION);
  const missScore = new Map<string, number>();
  for (const a of recent) {
    if (a.verdict === "correct") continue;
    missScore.set(a.topic_id, (missScore.get(a.topic_id) ?? 0) + (a.verdict === "incorrect" ? 2 : 1));
  }
  const focus = byId.get([...missScore.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "");
  const reviewNext = orderTopicsForReview(topics.filter((t) => t.mastery_level < 4 || t.danger_zone)).slice(0, 3);

  return (
    <div className="space-y-6">
      <div>
        <Link href={base} className="text-sm text-indigo-700 hover:underline">
          ← {name}
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">📈 My Progress</h1>
      </div>

      {/* Mastery overview */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-600">Course mastery</p>
            <p className="text-4xl font-bold text-slate-900">{mastery}%</p>
          </div>
          <dl className="grid grid-cols-3 gap-3 text-right text-sm">
            <div>
              <dt className="text-xs text-slate-500">Answered</dt>
              <dd className="text-lg font-bold">{attempts.length}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Correct</dt>
              <dd className="text-lg font-bold">{pct(correct, attempts.length)}%</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">To review</dt>
              <dd className="text-lg font-bold">{dangerCount > 0 ? `⚠️ ${dangerCount}` : "0"}</dd>
            </div>
          </dl>
        </div>
        <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-100" aria-hidden>
          {levelCounts.map((n, l) =>
            n > 0 ? (
              <span key={l} className={LEVEL_COLORS[l]} style={{ width: `${(n / topics.length) * 100}%` }} />
            ) : null,
          )}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
          {levelCounts.map((n, l) => (
            <li key={l} className="flex items-center gap-1">
              <span className={`inline-block h-2.5 w-2.5 rounded-sm ${LEVEL_COLORS[l]}`} />
              {LEVEL_NAMES[l]}: {n}
            </li>
          ))}
        </ul>
      </section>

      {attempts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-5 text-center text-sm text-slate-700">
          <p className="text-3xl" aria-hidden>
            🦉
          </p>
          <p className="mt-1">No quiz answers yet. Take a quick round and your stats will show up here.</p>
          <Link
            href={`${base}/quiz`}
            className="mt-3 inline-block rounded-xl bg-emerald-700 px-4 py-2.5 font-semibold text-white hover:bg-emerald-800"
          >
            🎯 Start a quiz
          </Link>
        </div>
      ) : (
        <>
          {/* Last session + review next */}
          <section className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="font-semibold text-slate-900">🕑 Last session</h2>
              <p className="mt-1 text-slate-800">
                You answered {recent.filter((a) => a.verdict === "correct").length}/{recent.length}.{" "}
                {focus ? (
                  <>
                    Focus on {focus.name}{" "}
                    <button
                      onClick={() => setOpenRange([focus.page_start, focus.page_end])}
                      className="font-semibold text-indigo-800 underline"
                    >
                      ({pageRange(focus.page_start, focus.page_end)})
                    </button>
                    .
                  </>
                ) : (
                  "All correct — great work! 🎉"
                )}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="font-semibold text-slate-900">📌 Review next</h2>
              {reviewNext.length === 0 ? (
                <p className="mt-1 text-sm text-slate-700">Every chapter is at the top level. Amazing! 🏆</p>
              ) : (
                <ol className="mt-1 space-y-1 text-sm">
                  {reviewNext.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-slate-800">
                        {t.danger_zone ? "⚠️ " : ""}
                        {t.name}
                      </span>
                      <button
                        onClick={() => setOpenRange([t.page_start, t.page_end])}
                        className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-200"
                      >
                        📄 {pageRange(t.page_start, t.page_end)}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              <Link
                href={`${base}/quiz?topic=weak`}
                className="mt-3 inline-block rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800"
              >
                🩹 Quiz my weak spots
              </Link>
            </div>
          </section>

          {/* Confidence calibration */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="font-semibold text-slate-900">🎯 Confidence vs. results</h2>
            <p className="text-sm text-slate-600">How often you were right at each confidence level.</p>
            <div className="mt-3 space-y-2">
              {calib.map((c) => (
                <div key={c.key} className="grid grid-cols-[7rem_1fr_4.5rem] items-center gap-2 text-sm">
                  <span className="text-slate-800">{c.label}</span>
                  <span className="h-3 overflow-hidden rounded-full bg-slate-100">
                    <span
                      className={`block h-full rounded-full ${c.acc >= 70 ? "bg-emerald-500" : c.acc >= 40 ? "bg-amber-400" : "bg-rose-400"}`}
                      style={{ width: `${c.n === 0 ? 0 : Math.max(4, c.acc)}%` }}
                    />
                  </span>
                  <span className="text-right text-slate-700">{c.n === 0 ? "—" : `${c.acc}% (${c.n})`}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-800">💡 {calibInsight}</p>
          </section>
        </>
      )}

      {/* Chapter mastery table */}
      <section className="rounded-2xl border border-slate-200 bg-white">
        <h2 className="border-b border-slate-100 px-4 py-3 font-semibold text-slate-900">🗂️ Chapter by chapter</h2>
        <ul className="divide-y divide-slate-100">
          {topics.map((t) => {
            const s = perTopic.get(t.id);
            return (
              <li key={t.id} className="px-4 py-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <button
                    onClick={() => setOpenRange([t.page_start, t.page_end])}
                    className="text-left font-semibold text-slate-900 hover:underline"
                  >
                    {t.danger_zone ? "⚠️ " : ""}
                    {t.name} <span className="font-normal text-slate-500">({pageRange(t.page_start, t.page_end)})</span>
                  </button>
                  <Link href={`${base}/quiz?topic=${t.id}`} className="shrink-0 text-xs font-semibold text-emerald-800 hover:underline">
                    🎯 Practise
                  </Link>
                </div>
                <div className="mt-1.5 flex items-center gap-3">
                  <div className="flex w-28 shrink-0 gap-0.5" aria-label={levelLabel(t.mastery_level)}>
                    {[1, 2, 3, 4].map((l) => (
                      <span key={l} className={`h-2 flex-1 rounded-sm ${l <= t.mastery_level ? LEVEL_COLORS[l] : "bg-slate-200"}`} />
                    ))}
                  </div>
                  <span className="text-xs text-slate-600">
                    {levelLabel(t.mastery_level)}
                    {s ? ` · ${pct(s.correct, s.n)}% correct (${s.n})` : ""} · {timeAgo(t.last_practiced_at)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Recent answers */}
      {attempts.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white">
          <h2 className="border-b border-slate-100 px-4 py-3 font-semibold text-slate-900">🧾 Recent answers</h2>
          <ul className="divide-y divide-slate-100 text-sm">
            {attempts.slice(0, 8).map((a, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2">
                <span aria-label={a.verdict}>{VERDICT_ICON[a.verdict]}</span>
                <span className="min-w-0 flex-1 truncate text-slate-800">
                  {byId.get(a.topic_id)?.name ?? "Topic"}
                  <span className="text-slate-500"> · {a.questions ? FORMATS[a.questions.format]?.label ?? "" : ""}</span>
                </span>
                <span className="shrink-0 text-xs text-slate-500">
                  {CONFIDENCE.find((c) => c.key === a.confidence)?.label.split(" ")[0]} {timeAgo(a.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {openRange && (
        <PageModal courseId={courseId} page={openRange[0]} range={openRange} onClose={() => setOpenRange(null)} />
      )}
    </div>
  );
}
