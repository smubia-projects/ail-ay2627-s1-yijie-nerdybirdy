import type { Request, RequestHandler } from "express";
import { createRateLimiter } from "./rateLimitEngine.js";
import { RateLimitError } from "@/lib/safety/limits";

/**
 * Rate-limit adapter: the shared engine (rateLimitEngine.js) with this project's slug
 * and one bucket per student action. The engine handles X-Forwarded-For, central config
 * from the control sheet, event mode, the kill switch (503) and fail-open. Without
 * Upstash credentials it is a no-op, which is what local dev wants.
 */
const limiter = createRateLimiter({
  // Slug = full project folder name (matches the central control-sheet rows).
  project: "ail-ay2627-s1-yijie-nerdybirdy",
  buckets: {
    ask: Number(process.env.RATE_LIMIT_ASK_MAX || 10), // an answer from the professor
    quiz: Number(process.env.RATE_LIMIT_QUIZ_MAX || 10), // a new quiz question (generate + verify)
    grade: Number(process.env.RATE_LIMIT_GRADE_MAX || 10), // a free-text answer graded (MCQs are free)
    notes: Number(process.env.RATE_LIMIT_NOTES_MAX || 5), // study notes for a topic (cached after)
    upload: Number(process.env.RATE_LIMIT_UPLOAD_MAX || 3), // one PDF: embeddings + topic map
  },
  redisUrl: process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_URL,
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_TOKEN,
  defaultWindow: Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 432000),
});

export type Bucket = "ask" | "quiz" | "grade" | "notes" | "upload";

/**
 * Runs the engine's middleware for one bucket, on demand, and at most once per request.
 * lib/ code calls this (as ctx.charge) right before its first model call, so cached
 * results and requests rejected by validation are not counted. A 429 or 503 from the
 * engine becomes a RateLimitError carrying the engine's body (queries_used / message).
 */
export function chargeOnce(req: Request, bucket: Bucket, run: (b: string) => RequestHandler = limiter): () => Promise<void> {
  let charged: Promise<void> | null = null;
  return () => {
    if (!charged) {
      charged = new Promise<void>((resolve, reject) => {
        let status = 200;
        const res = {
          status(code: number) {
            status = code;
            return res;
          },
          json(body: Record<string, unknown>) {
            reject(new RateLimitError(status === 503 ? 503 : 429, body));
            return res;
          },
        };
        Promise.resolve(run(bucket)(req, res as never, (err?: unknown) => (err ? reject(err) : resolve()))).catch(reject);
      });
    }
    return charged;
  };
}
