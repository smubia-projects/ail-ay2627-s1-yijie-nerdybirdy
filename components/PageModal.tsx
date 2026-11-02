"use client";

import { useEffect, useRef, useState } from "react";
import { Loading } from "@/components/Spinner";
import { getJSON } from "@/lib/api-client";

export function PageModal({
  courseId,
  page: initialPage,
  range,
  onClose,
}: {
  courseId: string;
  page: number;
  /** Optional [first, last] page range to step through with prev/next. */
  range?: [number, number];
  onClose: () => void;
}) {
  const [page, setPage] = useState(initialPage);
  const [loaded, setLoaded] = useState<{ page: number; text: string | null; failed: boolean } | null>(null);
  const text = loaded?.page === page ? loaded.text : null;
  const failed = loaded?.page === page ? loaded.failed : false;
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    getJSON<{ text: string | null }>(`/api/courses/${courseId}/pages/${page}`).then(
      ({ text }) => {
        if (active) setLoaded({ page, text, failed: text === null });
      },
      () => {
        if (active) setLoaded({ page, text: null, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [courseId, page]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="page-modal-title"
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 id="page-modal-title" className="font-semibold text-slate-900">
            📄 Page {page} of your notes
          </h2>
          <button
            ref={closeRef}
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-slate-600 hover:bg-slate-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {range && range[1] > range[0] && (
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-sm">
            <button
              onClick={() => setPage((p) => Math.max(range[0], p - 1))}
              disabled={page <= range[0]}
              className="rounded-lg px-2 py-1 font-medium text-indigo-800 hover:bg-indigo-50 disabled:opacity-40"
            >
              ← Previous
            </button>
            <span className="text-slate-600">
              Pages {range[0]}–{range[1]}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(range[1], p + 1))}
              disabled={page >= range[1]}
              className="rounded-lg px-2 py-1 font-medium text-indigo-800 hover:bg-indigo-50 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        )}
        <div className="overflow-y-auto px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap text-slate-800">
          {failed
            ? "We couldn't load this page."
            : text === null
              ? <Loading message="Loading page…" />
              : text.trim() || "This page has no readable text."}
        </div>
      </div>
    </div>
  );
}
