// Browser helper for calling the NerdyBirdy API (server/, on Cloud Run).
//
// The API runs separately from this Next.js frontend, so every request is prefixed
// with NEXT_PUBLIC_API_BASE (inlined at build time; locally the Express dev server on
// port 8080). There are no accounts: the browser keeps a random session id in
// localStorage and sends it as X-Session-Id, and the API scopes every query to it.
//
// The shared rate limiter's answers are handled here, once:
//  - 429 (limit reached) -> RATE_LIMIT_EVENT with queries_used, for the CTA modal
//  - 503 (demo paused)   -> DEMO_PAUSED_EVENT with the message, for the paused notice
// Both throw a HandledApiError, which callers treat as "already shown". A background
// request (the quiz's next question) passes { quiet: true } and calls announce() only
// if the student ends up waiting for it, so the card never pops up unprompted.

export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080").replace(/\/+$/, "");

export const RATE_LIMIT_EVENT = "nerdybirdy:rate-limit";
export const DEMO_PAUSED_EVENT = "nerdybirdy:demo-paused";
const SESSION_KEY = "nerdybirdy-session";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Thrown after a 429 or 503 has already been shown to the student. */
export class HandledApiError extends Error {
  constructor(
    public status: number,
    public detail: Record<string, unknown> = {},
  ) {
    super(status === 429 ? "You've reached this demo's limit." : "This demo is paused right now.");
  }
}

/** Shows the CTA (429) or the paused notice (503) for a limit hit. */
export function announce(err: HandledApiError): void {
  window.dispatchEvent(new CustomEvent(err.status === 429 ? RATE_LIMIT_EVENT : DEMO_PAUSED_EVENT, { detail: err.detail }));
}

export const isHandledApiError = (e: unknown): e is HandledApiError => e instanceof HandledApiError;

/** This browser's anonymous id, created on first use. Clearing site data starts over. */
export function sessionId(): string {
  let id: string | null = null;
  try {
    id = localStorage.getItem(SESSION_KEY);
  } catch {
    // Storage blocked: a fresh id per page load.
  }
  if (!id || !UUID.test(id)) {
    id = crypto.randomUUID();
    try {
      localStorage.setItem(SESSION_KEY, id);
    } catch {
      // ignore
    }
  }
  return id;
}

async function request<T>(method: string, path: string, body?: unknown, opts: { quiet?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { "X-Session-Id": sessionId(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("We couldn't reach NerdyBirdy. Check your internet connection and try again.");
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON response (e.g. a platform timeout page).
  }
  const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (res.status === 429 || res.status === 503) {
    const err = new HandledApiError(
      res.status,
      res.status === 429 ? { queriesUsed: Number(obj.queries_used) || 0 } : { message: String(obj.message ?? "") },
    );
    if (!opts.quiet) announce(err);
    throw err;
  }
  if (!res.ok) {
    throw new Error(typeof obj.error === "string" ? obj.error : "Something went wrong. Please try again.");
  }
  return data as T;
}

export const getJSON = <T>(path: string) => request<T>("GET", path);
export const postJSON = <T>(path: string, body: unknown, opts: { quiet?: boolean } = {}) =>
  request<T>("POST", path, body, opts);
export const deleteJSON = <T>(path: string) => request<T>("DELETE", path);

/** GET /api/courses/:id: the course (null when it isn't this browser's) and its topics. */
export type CourseResponse = {
  course: {
    id: string;
    name: string;
    exam_date: string | null;
    page_count: number;
    flagged_pages: number[];
    created_at: string;
  } | null;
  topics: {
    id: string;
    name: string;
    summary: string;
    page_start: number;
    page_end: number;
    mastery_level: number;
    level_progress: number;
    danger_zone: boolean;
    last_practiced_at: string | null;
  }[];
};
