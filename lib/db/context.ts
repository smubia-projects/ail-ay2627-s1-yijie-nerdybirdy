import "server-only";
import type { ScopedDb } from "@/lib/db/scoped";

/**
 * Who is asking, for the lib/ functions the API routes call.
 * userId is the anonymous session id the browser keeps (X-Session-Id); db only ever
 * reads and writes that user's rows. charge() takes this request's hit on the shared
 * AI Lodge rate limiter the first time a model is about to be called (lib/safety/limits.ts).
 */
export type UserContext = { db: ScopedDb; userId: string; charge?: () => Promise<void> };
