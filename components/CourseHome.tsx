"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { InjectionBanner } from "@/components/SafetyCards";
import { Loading } from "@/components/Spinner";
import { TopicNotesModal } from "@/components/TopicNotesModal";
import { LEVEL_NAMES, pageRange } from "@/lib/mastery";
import { deleteJSON, getJSON, type CourseResponse } from "@/lib/api-client";
import { useSession } from "@/lib/session";

type Course = {
  id: string;
  name: string;
  exam_date: string | null;
  page_count: number;
  flagged_pages: number[];
  created_at: string;
};

type Topic = {
  id: string;
  name: string;
  summary: string;
  page_start: number;
  page_end: number;
  mastery_level: number;
  danger_zone: boolean;
};

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error" }
  | { kind: "ok"; course: Course; topics: Topic[] };

function daysUntil(examDate: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(`${examDate}T00:00:00`).getTime() - today.getTime()) / 86_400_000);
}

function deletionDate(createdAt: string): string {
  const d = new Date(createdAt);
  d.setDate(d.getDate() + 7);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// Course home = study hub: what to do next, and the chapters to study.
// (Detailed stats live on the Progress page.)
export function CourseHome() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const session = useSession();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const [notesFor, setNotesFor] = useState<Topic | null>(null);

  useEffect(() => {
    if (session !== "ready") return;
    getJSON<CourseResponse>(`/api/courses/${id}`).then(
      ({ course, topics }) => {
        if (!course) setLoad({ kind: "missing" });
        else setLoad({ kind: "ok", course: course as Course, topics: topics as Topic[] });
      },
      () => setLoad({ kind: "error" }),
    );
  }, [session, id]);

  async function onDelete() {
    setDeleting(true);
    setDeleteError(false);
    const error = await deleteJSON(`/api/courses/${id}`).then(() => null, (err: unknown) => err);
    if (error) {
      setDeleting(false);
      setDeleteError(true);
      return;
    }
    router.push("/");
  }

  if (session === "error" || load.kind === "error") {
    return (
      <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800">
        We couldn&apos;t load this course. Please refresh the page.
      </p>
    );
  }
  if (load.kind === "loading") return <Loading message="Loading your course…" />;
  if (load.kind === "missing") {
    return (
      <div className="space-y-3 text-center">
        <p className="text-slate-700">
          We couldn&apos;t find this course. It may have been deleted, or it belongs to another browser session.
        </p>
        <Link href="/" className="font-medium text-indigo-700 underline">
          Back to home
        </Link>
      </div>
    );
  }

  const { course, topics } = load;
  const base = `/course/${course.id}`;
  const days = course.exam_date ? daysUntil(course.exam_date) : null;
  const dangerCount = topics.filter((t) => t.danger_zone).length;
  const startedCount = topics.filter((t) => t.mastery_level > 0).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link href="/" className="text-sm text-indigo-700 hover:underline">
          ← All courses
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">{course.name}</h1>
        <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold">
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">
            📄 {course.page_count} pages · {topics.length} chapters
          </span>
          {days !== null && (
            <span
              className={`rounded-full px-2.5 py-1 ${
                days < 0 ? "bg-slate-100 text-slate-600" : days <= 3 ? "bg-rose-100 text-rose-900" : "bg-amber-100 text-amber-900"
              }`}
            >
              📅{" "}
              {days > 1
                ? `Exam in ${days} days`
                : days === 1
                  ? "Exam tomorrow"
                  : days === 0
                    ? "Exam today — good luck!"
                    : "Exam date has passed"}
            </span>
          )}
        </div>
      </div>

      <InjectionBanner pages={course.flagged_pages ?? []} />

      {/* What to do */}
      <section className="grid gap-3 sm:grid-cols-3">
        <Link
          href={`${base}/ask`}
          className="group rounded-2xl bg-indigo-700 p-4 text-white shadow-sm hover:bg-indigo-800"
        >
          <p className="text-2xl" aria-hidden>
            💬
          </p>
          <p className="mt-1 font-bold">Ask the Professor</p>
          <p className="mt-0.5 text-sm text-indigo-100">Answers from your notes, with page numbers.</p>
        </Link>
        <Link
          href={`${base}/quiz`}
          className="rounded-2xl bg-emerald-700 p-4 text-white shadow-sm hover:bg-emerald-800"
        >
          <p className="text-2xl" aria-hidden>
            🎯
          </p>
          <p className="mt-1 font-bold">Quiz Mode</p>
          <p className="mt-0.5 text-sm text-emerald-100">5 checked questions, matched to your level.</p>
        </Link>
        <Link
          href={`${base}/progress`}
          className="rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 shadow-sm hover:border-indigo-300"
        >
          <p className="text-2xl" aria-hidden>
            📈
          </p>
          <p className="mt-1 font-bold">My Progress</p>
          <p className="mt-0.5 text-sm text-slate-600">
            {startedCount}/{topics.length} chapters started
            {dangerCount > 0 ? ` · ⚠️ ${dangerCount} to review` : ""}
          </p>
        </Link>
      </section>

      {/* Chapters */}
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-slate-900">📚 Chapters</h2>
          <p className="text-xs text-slate-500">Open 📘 Notes for a clean summary of each chapter</p>
        </div>
        {topics.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
            This course didn&apos;t finish setting up, so there are no chapters yet. Delete it below and upload your notes
            again.
          </p>
        ) : (
          <ol className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white">
            {topics.map((t, i) => (
              <li key={t.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-800">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900">
                      {t.danger_zone && <span title="Danger zone">⚠️ </span>}
                      {t.name}
                    </p>
                    <p className="line-clamp-2 text-sm text-slate-600">{t.summary}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {pageRange(t.page_start, t.page_end)} ·{" "}
                      {t.mastery_level === 0 ? "Not started" : `Level ${t.mastery_level} — ${LEVEL_NAMES[t.mastery_level]}`}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2 pl-10 sm:pl-0">
                  <button
                    onClick={() => setNotesFor(t)}
                    className="rounded-lg bg-indigo-50 px-3 py-1.5 text-sm font-semibold text-indigo-800 hover:bg-indigo-100"
                  >
                    📘 Notes
                  </button>
                  <Link
                    href={`${base}/quiz?topic=${t.id}`}
                    className="rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-100"
                  >
                    🎯 Quiz
                  </Link>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Privacy + delete */}
      <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
        <p className="text-slate-600">🔒 These notes will be deleted automatically on {deletionDate(course.created_at)}.</p>
        {!confirmDelete ? (
          <button onClick={() => setConfirmDelete(true)} className="mt-2 font-medium text-red-700 hover:underline">
            🗑️ Delete this course
          </button>
        ) : (
          <div className="mt-2 space-y-2">
            <p className="font-medium text-slate-900">
              Delete “{course.name}” and everything in it? This can&apos;t be undone.
            </p>
            <div className="flex gap-2">
              <button
                onClick={onDelete}
                disabled={deleting}
                className="rounded-lg bg-red-700 px-3 py-1.5 font-semibold text-white hover:bg-red-800 disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Yes, delete it"}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-800 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
            {deleteError && (
              <p role="alert" className="text-red-800">
                We couldn&apos;t delete the course. Please try again.
              </p>
            )}
          </div>
        )}
      </section>

      {notesFor && <TopicNotesModal courseId={course.id} topic={notesFor} onClose={() => setNotesFor(null)} />}
    </div>
  );
}
