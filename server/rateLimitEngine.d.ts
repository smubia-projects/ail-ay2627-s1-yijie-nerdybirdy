// Types for the vendored shared engine (rateLimitEngine.js, kept byte-identical to
// DOCS/shared/rate-limit/engine/node). Do not edit the .js file; update both from the source.
import type { RequestHandler } from "express";

export const ENGINE_VERSION: string;

export interface RateLimiterOptions {
  project: string;
  buckets: Record<string, number>;
  redisUrl?: string;
  redisToken?: string;
  defaultWindow?: number;
  cacheTtl?: number;
}

export function createRateLimiter(options: RateLimiterOptions): (bucket: string) => RequestHandler;
