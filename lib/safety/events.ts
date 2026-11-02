import type { ScopedDb } from "@/lib/db/scoped";

export type SafetyEventType =
  | "injection_flagged"
  | "citation_invalid"
  | "verification_failed"
  | "integrity_boundary"
  | "wellbeing_support"
  | "unsafe_request"
  | "rate_limited";

// Writes a safety event with the user-scoped db (own rows only).
// `detail` must never contain note or answer text: only ids, page numbers,
// pattern names and counts. Never throws.
export async function logSafetyEvent(
  db: ScopedDb,
  event: {
    type: SafetyEventType;
    courseId?: string | null;
    detail?: Record<string, string | number | boolean | null | (string | number)[]>;
  },
): Promise<void> {
  try {
    await db.from("safety_events").insert({
      type: event.type,
      course_id: event.courseId ?? null,
      detail: event.detail ?? {},
    });
  } catch {
    // Logging must never break the user's request.
  }
}
