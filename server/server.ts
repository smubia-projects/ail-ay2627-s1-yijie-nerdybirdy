import cors from "cors";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { z } from "zod";
import { askProfessor, parseAskRequest } from "@/lib/ask";
import { aiConfigured } from "@/lib/ai/openrouter";
import { IngestBatchSchema, LIMITS } from "@/lib/ai/schemas";
import type { UserContext } from "@/lib/db/context";
import { cleanupExpired, dbConfigured, ensureSchema, getPool } from "@/lib/db/pool";
import { scopedDb } from "@/lib/db/scoped";
import { routeError, UserFacingError } from "@/lib/http";
import { createCourse, finalizeCourse, ingestBatch } from "@/lib/ingest";
import { gradeAnswer, parseGradeRequest } from "@/lib/quiz/grade";
import { nextQuestion, NextRequestSchema } from "@/lib/quiz/next";
import { getStudyNotes } from "@/lib/topic-notes";
import { chargeOnce, type Bucket } from "./rateLimit";

/**
 * NerdyBirdy API (Cloud Run). API only: the Next.js frontend is on Vercel and calls
 * these routes via NEXT_PUBLIC_API_BASE. The lib/ functions are the ones the original
 * Next.js route handlers called; only who-is-asking changed (no Supabase auth: an
 * anonymous session id in X-Session-Id, and a database scoped to it, lib/db/scoped.ts).
 *
 *   GET    /api/health
 *   GET    /api/courses                     this browser's courses
 *   POST   /api/courses                     create a course (no model call)
 *   GET    /api/courses/:id                 one course and its topics
 *   DELETE /api/courses/:id                 delete a course and everything in it
 *   GET    /api/courses/:id/pages/:page     one page's text (citation viewer)
 *   GET    /api/courses/:id/attempts        quiz history (progress page)
 *   POST   /api/ingest                      store, chunk and embed a batch of pages  [upload, first batch]
 *   POST   /api/ingest/finalize             build the topic map                      [upload, if re-run]
 *   POST   /api/ask                         ask the professor                        [ask]
 *   POST   /api/quiz/next                   generate + verify a question             [quiz]
 *   POST   /api/quiz/grade                  grade an answer                          [grade, free text only]
 *   POST   /api/topic-notes                 study notes for a topic                  [notes, unless cached]
 */

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

app.use(
  cors({
    // No CORS_ORIGINS set (local dev) -> allow any origin. Otherwise only the listed ones.
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)),
    allowedHeaders: ["Content-Type", "X-Session-Id"],
    methods: ["GET", "POST", "DELETE"],
  }),
);
// A batch is at most 20 pages of 20,000 characters.
app.use(express.json({ limit: "2mb" }));

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const Uuid = z.uuid();

type Handler = (req: Request, ctx: UserContext) => Promise<unknown>;

async function send(res: Response, out: globalThis.Response) {
  res.status(out.status).json(await out.json());
}

/**
 * Wraps a route: checks the session id and the database, runs the TTL cleanup, builds the
 * user-scoped context, and maps errors the way the Next.js handlers did (lib/http.ts).
 * `bucket` (when the route calls a model) makes ctx.charge take one limiter hit.
 */
function route(where: string, handler: Handler, opts: { bucket?: Bucket; ai?: boolean } = {}) {
  return async (req: Request, res: Response) => {
    const userId = String(req.get("X-Session-Id") ?? "");
    if (!SESSION.test(userId)) {
      return res.status(401).json({ error: "Your session has expired. Please refresh the page." });
    }
    if (!dbConfigured()) return res.status(501).json({ error: "The database is not configured (DATABASE_URL)." });
    if (opts.ai && !aiConfigured()) return res.status(501).json({ error: "AI is not configured on this server (API_KEY)." });
    try {
      await ensureSchema();
      await cleanupExpired();
      const ctx: UserContext = {
        db: scopedDb(getPool(), userId.toLowerCase()),
        userId: userId.toLowerCase(),
        charge: opts.bucket ? chargeOnce(req, opts.bucket) : undefined,
      };
      res.json(await handler(req, ctx));
    } catch (err) {
      await send(res, routeError(err, where));
    }
  };
}

function courseIdOf(req: Request): string {
  const id = Uuid.safeParse(req.params.id);
  if (!id.success) throw new UserFacingError("We couldn't find that course.", 404);
  return id.data;
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ---------- Courses (reads the components used to make with the Supabase browser client) ----------

app.get(
  "/api/courses",
  route("courses", async (_req, ctx) => {
    const { data, error } = await ctx.db
      .from("courses")
      .select("id, name, page_count, exam_date")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return { courses: data };
  }),
);

const CreateCourseSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.maxCourseNameChars),
  examDate: z.iso.date().nullable(),
  pageCount: z.number().int().min(1).max(LIMITS.maxPages),
});

app.post(
  "/api/courses",
  route("courses", async (req, ctx) => {
    const parsed = CreateCourseSchema.safeParse(req.body);
    if (!parsed.success) throw new UserFacingError("Please give your course a name (up to 120 characters).");
    return createCourse(ctx, parsed.data);
  }),
);

app.get(
  "/api/courses/:id",
  route("course", async (req, ctx) => {
    let id: string;
    try {
      id = courseIdOf(req);
    } catch {
      return { course: null, topics: [] };
    }
    const [c, t] = await Promise.all([
      ctx.db
        .from("courses")
        .select("id, name, exam_date, page_count, flagged_pages, created_at")
        .eq("id", id)
        .maybeSingle(),
      ctx.db
        .from("topics")
        .select("id, name, summary, page_start, page_end, mastery_level, level_progress, danger_zone, last_practiced_at")
        .eq("course_id", id)
        .order("page_start"),
    ]);
    if (c.error) throw c.error;
    if (t.error) throw t.error;
    return { course: c.data, topics: c.data ? t.data : [] };
  }),
);

app.delete(
  "/api/courses/:id",
  route("course/delete", async (req, ctx) => {
    const { error } = await ctx.db.from("courses").delete().eq("id", courseIdOf(req));
    if (error) throw error;
    return { ok: true };
  }),
);

app.get(
  "/api/courses/:id/pages/:page",
  route("course/page", async (req, ctx) => {
    const page = Number(req.params.page);
    if (!Number.isInteger(page) || page < 1) return { text: null };
    const { data, error } = await ctx.db
      .from("pages")
      .select("text")
      .eq("course_id", courseIdOf(req))
      .eq("page_number", page)
      .maybeSingle();
    if (error) throw error;
    return { text: (data?.text as string | undefined) ?? null };
  }),
);

app.get(
  "/api/courses/:id/attempts",
  route("course/attempts", async (req, ctx) => {
    const { data, error } = await ctx.db
      .from("attempts")
      .select("topic_id, verdict, confidence, created_at, questions(format)")
      .eq("course_id", courseIdOf(req))
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) throw error;
    return { attempts: data };
  }),
);

// ---------- Upload: one limiter hit per PDF ----------

app.post(
  "/api/ingest",
  route(
    "ingest",
    async (req, ctx) => {
      const parsed = IngestBatchSchema.safeParse(req.body);
      if (!parsed.success) throw new UserFacingError("That batch of pages didn't look right. Please try uploading again.");
      const { courseId, pages } = parsed.data;
      // Only the first batch of a course is charged: later batches of the same PDF are free.
      const { count } = await ctx.db.from("pages").select("id", { count: "exact", head: true }).eq("course_id", courseId);
      return ingestBatch((count ?? 0) > 0 ? { ...ctx, charge: undefined } : ctx, courseId, pages);
    },
    { bucket: "upload", ai: true },
  ),
);

const FinalizeSchema = z.object({ courseId: z.uuid() });

app.post(
  "/api/ingest/finalize",
  route(
    "ingest/finalize",
    async (req, ctx) => {
      const parsed = FinalizeSchema.safeParse(req.body);
      if (!parsed.success) throw new UserFacingError("Missing course.");
      // The topic map is part of the upload already charged; building it again is charged.
      const { count } = await ctx.db
        .from("topics")
        .select("id", { count: "exact", head: true })
        .eq("course_id", parsed.data.courseId);
      return finalizeCourse((count ?? 0) > 0 ? ctx : { ...ctx, charge: undefined }, parsed.data.courseId);
    },
    { bucket: "upload", ai: true },
  ),
);

// ---------- The AI features ----------

app.post(
  "/api/ask",
  route(
    "ask",
    async (req, ctx) => {
      const parsed = parseAskRequest(req.body);
      if (!parsed.ok) throw new UserFacingError(parsed.message);
      return askProfessor(ctx, parsed.data);
    },
    { bucket: "ask", ai: true },
  ),
);

app.post(
  "/api/quiz/next",
  route(
    "quiz/next",
    async (req, ctx) => {
      const parsed = NextRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new UserFacingError("Pick a topic and a question type first.");
      return nextQuestion(ctx, parsed.data);
    },
    { bucket: "quiz", ai: true },
  ),
);

app.post(
  "/api/quiz/grade",
  route(
    "quiz/grade",
    async (req, ctx) => {
      const parsed = parseGradeRequest(req.body);
      if (!parsed.ok) throw new UserFacingError(parsed.message);
      return gradeAnswer(ctx, parsed.data);
    },
    { bucket: "grade", ai: true },
  ),
);

const NotesRequestSchema = z.object({ topicId: z.uuid() });

app.post(
  "/api/topic-notes",
  route(
    "topic-notes",
    async (req, ctx) => {
      const parsed = NotesRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new UserFacingError("Missing topic.");
      return getStudyNotes(ctx, parsed.data.topicId);
    },
    { bucket: "notes", ai: true },
  ),
);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found. This is the NerdyBirdy API; the app itself is on the frontend." });
});

// Express needs all four parameters to treat this as the error handler.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = Number((err as { status?: number }).status) || 500;
  if (status === 413) return res.status(413).json({ error: "That request is too large." });
  if (status === 400) return res.status(400).json({ error: "Expected JSON." });
  console.error(err instanceof Error ? err.name : "unknown");
  return res.status(500).json({ error: "Something went wrong on our side. Please try again." });
};
app.use(onError);

export { app };

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT) || 8080;
  app.listen(port, "0.0.0.0", () => {
    console.log(`NerdyBirdy API listening on 0.0.0.0:${port}`);
  });
}
