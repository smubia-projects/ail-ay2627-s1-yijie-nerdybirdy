// Browser-side upload pipeline: validate pages, create the course, send page
// text in batches, then build the topic map. Used for PDFs and sample notes.
import { LIMITS } from "@/lib/ai/schemas";
import { deleteJSON, postJSON } from "@/lib/api-client";
import type { PageText } from "@/lib/pdf/extract";

export const SCANNED_PDF_MESSAGE =
  "This looks like a scanned PDF. NerdyBirdy can only read PDFs with selectable text.";

export function validatePages(pages: PageText[]): string | null {
  if (pages.length === 0) return "That PDF has no pages.";
  if (pages.length > LIMITS.maxPages) {
    return `This PDF has ${pages.length} pages. NerdyBirdy can read up to ${LIMITS.maxPages} pages.`;
  }
  const unreadable = pages.filter((p) => p.text.trim().length < LIMITS.minReadablePageChars).length;
  if (unreadable > pages.length / 2) return SCANNED_PDF_MESSAGE;
  return null;
}

export type UploadStep = "reading" | "finding" | "ready";

export async function uploadNotes(input: {
  name: string;
  examDate: string | null;
  pages: PageText[];
  onStep: (step: UploadStep, detail?: string) => void;
}): Promise<{ courseId: string; flaggedPages: number[] }> {
  const { id: courseId } = await postJSON<{ id: string }>("/api/courses", {
    name: input.name,
    examDate: input.examDate,
    pageCount: input.pages.length,
  });

  try {
    const total = input.pages.length;
    for (let i = 0; i < total; i += LIMITS.ingestBatchPages) {
      const batch = input.pages.slice(i, i + LIMITS.ingestBatchPages);
      input.onStep("reading", `Pages ${i + 1}–${i + batch.length} of ${total}`);
      await postJSON("/api/ingest", { courseId, pages: batch });
    }
    input.onStep("finding");
    const result = await postJSON<{ flaggedPages: number[] }>("/api/ingest/finalize", { courseId });
    input.onStep("ready");
    return { courseId, flaggedPages: result.flaggedPages };
  } catch (err) {
    // Don't leave a half-built course behind.
    await deleteJSON(`/api/courses/${courseId}`).catch(() => undefined);
    throw err;
  }
}
