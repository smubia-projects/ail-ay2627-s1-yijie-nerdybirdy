"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Spinner } from "@/components/Spinner";
import { UploadDropzone } from "@/components/UploadDropzone";
import { LIMITS } from "@/lib/ai/schemas";
import { getJSON } from "@/lib/api-client";
import { useSession } from "@/lib/session";
import { uploadNotes, validatePages, type UploadStep } from "@/lib/upload";
import type { PageText } from "@/lib/pdf/extract";

type CourseSummary = { id: string; name: string; page_count: number; exam_date: string | null };

type Status =
  | { kind: "idle" }
  | { kind: "working"; step: UploadStep; detail?: string }
  | { kind: "error"; message: string };

const SAMPLE_NAME = "BIO101 Lecture 5: Photosynthesis";

const STEPS: { step: UploadStep; label: string }[] = [
  { step: "reading", label: "📖 Reading your notes…" },
  { step: "finding", label: "🧭 Finding topics…" },
  { step: "ready", label: "✅ Ready!" },
];

export function HomeClient() {
  const router = useRouter();
  const session = useSession();
  const [courses, setCourses] = useState<CourseSummary[] | null>(null);
  const [coursesError, setCoursesError] = useState(false);
  const [name, setName] = useState("");
  const [examDate, setExamDate] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    if (session !== "ready") return;
    getJSON<{ courses: CourseSummary[] }>("/api/courses").then(
      ({ courses }) => setCourses(courses),
      () => setCoursesError(true),
    );
  }, [session]);

  const busy = status.kind === "working";
  const atCourseLimit = (courses?.length ?? 0) >= LIMITS.maxCoursesPerUser;

  async function run(pagesPromise: Promise<PageText[]>, courseName: string) {
    try {
      setStatus({ kind: "working", step: "reading" });
      const pages = await pagesPromise;
      const problem = validatePages(pages);
      if (problem) {
        setStatus({ kind: "error", message: problem });
        return;
      }
      const { courseId } = await uploadNotes({
        name: courseName,
        examDate: examDate || null,
        pages,
        onStep: (step, detail) => setStatus({ kind: "working", step, detail }),
      });
      router.push(`/course/${courseId}`);
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Something went wrong. Please try again.",
      });
    }
  }

  function onUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setStatus({ kind: "error", message: "Choose a PDF first." });
      return;
    }
    if (file.size > LIMITS.maxPdfBytes) {
      setStatus({ kind: "error", message: "That PDF is over 25 MB. Try a smaller file." });
      return;
    }
    if (!name.trim()) {
      setStatus({ kind: "error", message: "Give your course a name first." });
      return;
    }
    const pages = import("@/lib/pdf/extract").then(({ extractPdfPages }) =>
      extractPdfPages(file, (done, total) =>
        setStatus({ kind: "working", step: "reading", detail: `Opening page ${done} of ${total}` }),
      ),
    );
    void run(pages, name.trim());
  }

  function onSample() {
    const pages = fetch("/samples/photosynthesis.json").then((r) => {
      if (!r.ok) throw new Error("Couldn't load the sample notes.");
      return r.json() as Promise<PageText[]>;
    });
    void run(pages, name.trim() || SAMPLE_NAME);
  }

  return (
    <div className="space-y-8">
      <section className="text-center">
        <div className="text-6xl" aria-hidden>
          🦉
        </div>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">
          Your AI professor for <span className="text-indigo-700">your</span> notes
        </h1>
        <p className="mt-2 text-slate-700">
          Upload your lecture notes. Ask questions, get answers with page numbers, and quiz yourself
          before the real exam does.
        </p>
      </section>

      {session === "error" && (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800">
          We couldn&apos;t start your session. Please refresh the page. If it keeps happening, check
          that cookies are allowed.
        </p>
      )}

      <form
        onSubmit={onUpload}
        className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
      >
        <h2 className="text-lg font-semibold text-slate-900">Add your notes</h2>
        <div>
          <label htmlFor="course-name" className="block text-sm font-medium text-slate-800">
            Course name
          </label>
          <input
            id="course-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={LIMITS.maxCourseNameChars}
            placeholder="e.g. BIO101 Midterm"
            disabled={busy}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="exam-date" className="block text-sm font-medium text-slate-800">
            Exam date <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <input
            id="exam-date"
            type="date"
            value={examDate}
            onChange={(e) => setExamDate(e.target.value)}
            disabled={busy}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <UploadDropzone file={file} onFile={setFile} disabled={busy} />

        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
          🔒 Your notes are only used to teach you. We keep the extracted text for 24 hours, then
          delete it. Please don&apos;t upload personal or confidential information.
        </p>

        {atCourseLimit && (
          <p className="text-sm text-amber-800">
            You have {LIMITS.maxCoursesPerUser} courses already. Delete one below to add another.
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="submit"
            disabled={busy || session !== "ready" || atCourseLimit}
            className="flex-1 rounded-lg bg-indigo-700 px-4 py-2.5 font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
          >
            Upload &amp; start studying
          </button>
          <button
            type="button"
            onClick={onSample}
            disabled={busy || session !== "ready" || atCourseLimit}
            className="flex-1 rounded-lg border border-indigo-300 bg-indigo-50 px-4 py-2.5 font-semibold text-indigo-800 hover:bg-indigo-100 disabled:opacity-50"
          >
            🌱 Try with sample notes
          </button>
        </div>

        {status.kind === "working" && (
          <ol aria-live="polite" className="space-y-1 rounded-lg bg-indigo-50 px-4 py-3 text-sm">
            {STEPS.map(({ step, label }, i) => {
              const current = STEPS.findIndex((s) => s.step === status.step);
              const state = i < current ? "done" : i === current ? "active" : "todo";
              return (
                <li
                  key={step}
                  className={`flex items-center gap-2 ${
                    state === "todo"
                      ? "text-slate-400"
                      : state === "active"
                        ? "font-semibold text-indigo-900"
                        : "text-slate-600"
                  }`}
                >
                  {state === "active" && step !== "ready" ? (
                    <Spinner className="h-4 w-4 shrink-0" />
                  ) : (
                    <span className="w-4 shrink-0 text-center text-xs">{state === "done" ? "✓" : "·"}</span>
                  )}
                  {label}
                  {state === "active" && status.detail ? (
                    <span className="ml-2 font-normal text-slate-600">{status.detail}</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {status.kind === "error" && (
          <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
            {status.message}
          </p>
        )}
      </form>

      <section>
        <h2 className="text-lg font-semibold text-slate-900">Your courses</h2>
        {coursesError ? (
          <p className="mt-2 text-sm text-red-800">We couldn&apos;t load your courses. Please refresh.</p>
        ) : courses === null ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-slate-500">
            <Spinner className="h-4 w-4" /> Loading your courses…
          </p>
        ) : courses.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">
            No courses yet. Upload a PDF or try the sample notes to get started.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {courses.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/course/${c.id}`}
                  className="block rounded-xl border border-slate-200 bg-white px-4 py-3 hover:border-indigo-400"
                >
                  <span className="font-medium text-slate-900">{c.name}</span>
                  <span className="ml-2 text-sm text-slate-500">
                    {c.page_count} pages{c.exam_date ? ` · exam ${c.exam_date}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
