# Decisions

One line per decision or deviation from docs/SPEC.md.

## Phase 0
- Folder structure: empty folders hold a `.gitkeep`; route and page files are created in the phase that implements them, so the build never contains half-written routes.
- DB: every `user_id` also references `auth.users(id) on delete cascade`, so deleting a (test or anonymous) user removes all their data.
- DB: insert/update policies on pages, chunks, topics, questions and attempts also require that `course_id` belongs to the user (defence in depth).
- DB: added CHECK constraints for confidence, verdict, score, level and mastery ranges; `questions.format` and `safety_events.type` have no CHECK so Phase 5 can add formats/types without a migration.
- DB: `question_keys.user_id` has no `default auth.uid()` because only the admin client writes it (auth.uid() would be null); the server sets it explicitly.
- DB: no HNSW index on `chunks.embedding`. An approximate index applies the `course_id` filter after the nearest-neighbour search and can return too few rows; at ≤150 pages per course an exact scan via `chunks_course_id_idx` is fast and correct.
- DB: `match_chunks` caps `p_count` at 20.
- LLM: one retry on 429/5xx with backoff is done by the OpenAI SDK (`maxRetries: 1`, `timeout: 45s`).
- LLM: `callJSON` tries json_schema (+ low reasoning when asked) → json_schema → json_object, moving on only when OpenRouter rejects the parameters (400/404). A data-policy rejection is never bypassed; it surfaces as `LLMError("no_provider")`. The working variant is cached per model.
- LLM: the HTTP-Referer header uses Vercel's `VERCEL_PROJECT_PRODUCTION_URL` (falls back to http://localhost:3000), so no extra env var is needed.
- LLM: schemas use `.nullable()` rather than `.optional()` so they work with strict json_schema.
- Scripts: `tsx` runs with `--conditions=react-server` so files that `import "server-only"` can be reused by scripts/evals, and with `--env-file=.env.local`.
- .env.example has empty values only (the MODEL_EMBED example moved into a comment).

## Phase 1
- Pages are thin server components that render client components; data is read in the browser with the publishable-key Supabase client (RLS protects it). This keeps Cache Components happy (no cookies() in server components) and makes navigation instant. Components using useParams() sit behind <Suspense>.
- No `runtime` export on route handlers: Next 16 with Cache Components forbids it, and Node.js is already the default (never Edge).
- Added app/api/courses/route.ts (create course) so the 5-course limit is enforced on the server. Deleting a course is done from the browser through RLS; foreign keys cascade.
- If any ingest step fails, the browser deletes the half-built course so no broken course is left behind.
- Ingest logic lives in lib/ingest.ts (routes stay thin), so the evals can call the same functions.
- Added lib/safety/events.ts (safety_events writer), lib/http.ts (friendly error mapping), lib/upload.ts (browser pipeline), lib/api-client.ts and lib/supabase/use-session.ts.
- Rate limiting counts each chat call and each embedding batch call as 1 LLM call.
- maxDuration = 120 s on LLM routes (45 s timeout + one retry can exceed 60 s; Vercel Fluid compute allows it on Hobby).
- Embeddings are computed on "Page N: <chunk>" so page context helps retrieval; the stored chunk content has no prefix.
- Topic map input is capped at about 100k characters, shared evenly across pages.
- The pdf.js worker is copied to public/ by the predev/prebuild scripts (gitignored, ignored by ESLint), so it always matches the installed pdfjs-dist version.
- Light theme only (no dark mode) for consistent high contrast.
- The course home shows the automatic deletion date (created_at + 7 days) for transparency.

## Phase 2
- Ask logic lives in lib/ask.ts (parseAskRequest + askProfessor), so the evals can call it directly.
- A grounded answer must also contain at least one inline [p. N] citation (stricter than the spec, so every "from your notes" answer shows chips).
- If the student names a page outside 1..page_count ("what does page 40 say?"), the answer is not_in_notes with no LLM call. If they name a real page, that page's chunks are added to the retrieved set.
- Chat history (last 6 messages, sent by the browser) goes into the prompt as an <untrusted_conversation> block, because the client could fake it.
- Follow-up buttons resend the original question with a fixed follow-up instruction (simpler / example / why), so retrieval still uses the original question.
- "What's your system prompt?" is answered as not_in_notes with a one-line refusal (nothing revealed).
- not_in_notes shows a fixed UI message (plus a deterministic note for missing pages) and never shows model text, so nothing ungrounded is shown as if it came from the notes.
- The wellbeing card's resources block and "talk to someone you trust" line are hard-coded in lib/safety/wellbeing.ts; the keyword path also uses a hard-coded supportive message.
- Integrity, wellbeing and unsafe replies have any [p. N] stripped. General ("Explain anyway") answers always have citations stripped and carry the "⚠️ Not from your syllabus" badge.
- Markdown is rendered by a small built-in renderer (components/Markdown.tsx) that emits only React text nodes, so there is no HTML injection and no extra dependency.
- The page viewer reads page text in the browser through RLS (no extra route).
- Temperature 0.3 for Ask answers (not specified in the spec).

## Phase 3
- Quiz logic lives in lib/quiz/next.ts (choose topic/level/format → generate → check pages → verify → save) and lib/quiz/grade.ts; browser-safe response types are in lib/quiz/types.ts.
- Before calling the checker model, a deterministic check requires every key point, source page and original-statement page to be one of the pages actually shown to the generator (stricter than "within the course").
- MCQ options are shuffled on the server after generation, so the answer isn't always "A".
- Verification failure: up to 3 attempts per topic (first try + 2 regenerations with the checker's issues), then one other topic, then a friendly 422. New attempts stop after about 200 s; /api/quiz/next has maxDuration = 300.
- verification_failed events log only the format, attempt number, failed check names and an issue count, never the issue text (it can quote notes).
- Comeback questions are derived from the topic's latest attempt (missed key points + its format), so no extra column is needed. The comeback format is deterministic (lib/quiz/formats.ts → comebackFormat), so the feedback card's "🔁 This will come back as…" line matches what /api/quiz/next does. If the student forces a format that differs from the missed one, it is kept.
- Choosing a specific format sets the question's level to that format's level. Only questions at the topic's target level (mastery_level + 1) count toward levelling up.
- "Review my weak spots" = danger-zone topics plus topics whose latest attempt wasn't correct, in review order; if there are none, it falls back to "Mix it up" order. Mix/weak avoid the topic just asked when another is available.
- Pre-fetching: while the student answers, the browser requests the next question. It is discarded if the student just missed points or levelled up on that topic (it would be stale), and a fresh one is requested.
- Grading: an mcq attempt stores the chosen option's text as the answer. Free-text answers that trigger the self-harm keyword check show the wellbeing card instead of being graded (no attempt is saved). Instruction-like answers are graded normally and logged as injection_flagged (source "answer", pattern names only).
- The grader schema is rebuilt per question so key_point_results must have exactly one entry per key point. Hits are matched by position, and the score/verdict are computed in code.
- A question can be answered once (409 after that).
- After submitting, the model answer / correct option / original statement are revealed (allowed: the rule only forbids sending them before submission).
- Progress page "session summary" = the 5 most recent attempts on the course (sessions aren't stored). The quiz screen shows its own end-of-round summary.
- Danger zone clears when the 2 most recent attempts on the topic are both correct.
- LLM speed: MODEL_PROFESSOR/CHECKER resolve to a reasoning model, and OpenRouter provider speed varied from about 1 s to 80 s for the same prompt (default reasoning effort, slow provider), which caused 45 s timeouts. Every call now asks for low reasoning effort (dropped automatically if unsupported) and sends provider `sort: "throughput"`. data_collection: "deny" and require_parameters are unchanged.
- Grader output strings have no schema length limits; they are trimmed in code (evidence 300, mixed_up_with 120, feedback 600 chars) so a long sentence doesn't fail the whole grade.
- callJSON logs which validation rule failed (paths and constraints only, never content) when the output is invalid twice.

## Phase 4
- Evals (evals/cases.ts + evals/run-evals.ts, `npm run evals`) call lib functions directly with two real anonymous users. Grading cases use hand-written questions with fixed answer keys from the sample notes, so their setup is deterministic and only the grading is model-dependent. Case 23 generates a real question. `npm run evals -- 7 9` runs selected cases without rewriting the report.
- Evals run 4 cases at a time (about 45 s total). Test users are deleted at the end, which cascades all their rows; their usage counters are removed too.
- docs/safety-tests.md lists no model IDs (they are .env.local values); the README will list them once they're pinned.
- Cron runs daily at 19:00 UTC (03:00 SGT). Besides the keep-alive query and deleting courses older than 7 days, it trims usage rows and safety_events older than 30 days (they hold no note/answer text, so 30 days is enough for review). The CRON_SECRET check uses a constant-time comparison.
- vercel.json also pins functions to `sin1` (matches the Supabase region), in addition to the dashboard setting.
- Added basic security headers (nosniff, DENY framing, strict referrer, no camera/mic/geo) in next.config.ts.
- Known, accepted: RLS lets a user write their own topics/attempts/questions directly from the browser. That can only change their own progress, and answer keys stay unreachable (question_keys has no grants).

## Fixes
- PDF upload: pdfjs-dist 6.x's default build uses brand-new JS APIs (Uint8Array.prototype.toHex, Map.prototype.getOrInsertComputed, Math.sumPrecise) that current Chrome/V8 lacks, so opening any PDF failed. We now import `pdfjs-dist/legacy/build/pdf.mjs` and serve the legacy worker (includes polyfills). PDF errors now say whether the file is password-protected, invalid, or unreadable in this browser.

## Phase 6
- Phase 5 (should-haves) was skipped: the user asked to finish and ship instead.
- Topic cards (course home + progress) now have "📄 Read p. x–y" (page viewer with prev/next) and "🎯 Quiz this topic" (`/quiz?topic=<id>` preselects it).
- PDF byte pre-check before pdf.js: empty files, HTML pages saved as .pdf, and Office/zip files get specific messages instead of a generic "invalid PDF".
- Added app/not-found.tsx and app/error.tsx (friendly 404 and error boundary), and `overflow-wrap:anywhere` on <main> so long words/URLs don't cause horizontal scroll at 375 px.
- README model IDs: `~deepseek/deepseek-flash-latest` resolved to `deepseek/deepseek-v4.1-flash` for every call during development and evals; that ID was verified directly (strict JSON + low reasoning + data_collection deny). Embeddings: openai/text-embedding-3-small (1536).
- LICENSE: MIT, copyright holder "SMUYijie" (the GitHub account).

## Post-launch improvements (user feedback)
- Quiz waits: the browser keeps up to 2 verified questions ready ahead, generated one at a time (so each new question sees the previous ones and doesn't repeat them). Questions are no longer discarded after a miss; instead a comeback question for that topic is generated in the background and inserted after the next ready question. Deviation: the comeback can arrive one question later than "the next question on that topic", in exchange for no waiting.
- Fresh quiz on every entry: Next 16 keeps visited pages alive with React Activity, so the old round reappeared. The quiz is keyed by `useRouter().bfcacheId` + the search params (bfcacheId alone doesn't change for ?topic= changes). Added an "End quiz" button (summary if anything was answered).
- Loading: a shared Spinner/Loading/LoadingCard (components/Spinner.tsx) on every wait, with rotating status messages for long waits.
- Study notes: /api/topic-notes generates clean per-chapter notes (sections, key terms, watch-outs) from that chapter's pages only. Points whose pages weren't shown are dropped (grounding), output is zod-validated, and the call counts toward the daily limit. They're cached in topics.study_notes (migration 0002); if the column doesn't exist yet, notes are generated without caching.
- Course home = study hub (action tiles + numbered chapter list with 📘 Notes / 🎯 Quiz). Progress = analytics (mastery %, level breakdown, confidence calibration, per-chapter accuracy, recent answers).

## AI Lodge showcase deployment (Nov 2026)

- Supabase (anonymous auth + RLS) → Neon + an anonymous session id (`X-Session-Id`). RLS's `user_id = auth.uid()` is now added to every statement by `lib/db/scoped.ts`; `tests/scoped-db.test.ts` checks it.
- Next.js route handlers → an Express API in `server/` on Cloud Run (esbuild bundle, `--conditions=react-server` so `server-only` resolves); Next.js is frontend only.
- Embeddings 1536 → 768 dims (`dimensions: 768`), the club's pgvector standard.
- Model env names: `MODEL_NAME` / `CHECKER_MODEL_NAME` / `EMBEDDING_MODEL_NAME` / `API_KEY` / `API_BASE_URL` first, the original names as fallbacks. Off OpenRouter, non-GPT models start at json_object with the schema in the prompt; gpt-5 models get no temperature (they accept only the default).
- `bump_usage` daily caps → the shared AI Lodge rate limiter (one hit per student action, before the first model call). Background quiz prefetches don't pop the limit card; it shows only when the student is waiting.
- Cron keep-alive and 7-day retention → 24-hour retention, cleaned up on ordinary requests.
- Demo limits: 60 pages per PDF, 3 courses per visitor.
