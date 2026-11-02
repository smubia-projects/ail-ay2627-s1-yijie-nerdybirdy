import "server-only";

// The AI limit is the shared AI Lodge rate limiter (server/rateLimit.ts): one hit per
// student action (an answer, a quiz question, a grading, study notes, an upload), taken
// right before the first model call of the request, so cached results and requests
// rejected by validation cost nothing. It replaces the per-user and global daily
// counters (one cost control: the shared limiter, its kill switch and the key's spend limit).

/** Thrown when the limiter says no: 429 (limit reached, the CTA) or 503 (demo paused). */
export class RateLimitError extends Error {
  constructor(
    public status: 429 | 503,
    public body: Record<string, unknown>,
  ) {
    super(status === 429 ? "Rate limit exceeded." : "This demo is temporarily paused.");
    this.name = "RateLimitError";
  }
}

// Called before every model call (chat or embedding). Only the first call in a request
// is charged; ctx.charge does that bookkeeping. Without a charge (evals, scripts) it is free.
export async function spendLLMCalls(
  ctx: { charge?: () => Promise<void>; courseId?: string | null },
  _calls = 1, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<void> {
  if (ctx.charge) await ctx.charge();
}
