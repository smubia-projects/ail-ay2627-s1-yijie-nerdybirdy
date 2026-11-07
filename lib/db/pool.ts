import "server-only";
import { Pool, types } from "pg";

// Neon Postgres (DATABASE_URL). Replaces Supabase: there is no auth service and no
// RLS, so every query goes through lib/db/scoped.ts, which adds the session's
// user_id to each statement itself.

// Match what Supabase's REST API returned: dates and timestamps as strings, numbers as numbers.
types.setTypeParser(1082, (v) => v); // date -> "YYYY-MM-DD"
types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz -> ISO string
types.setTypeParser(1700, (v) => Number(v)); // numeric -> number
types.setTypeParser(20, (v) => Number(v)); // int8 (count) -> number

export const EMBED_DIMENSIONS = 768;
export const NOTES_TTL_HOURS = Number(process.env.NOTES_TTL_HOURS || 24);

// The schema from supabase/migrations, for Neon: user_id is the anonymous session id
// (no auth.users), vectors are 768-dim, and the usage counters are gone (the shared
// AI Lodge rate limiter replaces them).
const SCHEMA = `
create extension if not exists vector;

create table if not exists courses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  name          text not null check (char_length(name) between 1 and 120),
  exam_date     date,
  page_count    int  not null default 0 check (page_count between 0 and 150),
  flagged_pages int[] not null default '{}',
  created_at    timestamptz not null default now()
);
create table if not exists pages (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references courses (id) on delete cascade,
  user_id     uuid not null,
  page_number int  not null check (page_number >= 1),
  text        text not null,
  unique (course_id, page_number)
);
create table if not exists chunks (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references courses (id) on delete cascade,
  user_id     uuid not null,
  page_number int  not null check (page_number >= 1),
  content     text not null,
  embedding   vector(${EMBED_DIMENSIONS}) not null
);
create table if not exists topics (
  id                uuid primary key default gen_random_uuid(),
  course_id         uuid not null references courses (id) on delete cascade,
  user_id           uuid not null,
  name              text not null,
  summary           text not null default '',
  page_start        int  not null check (page_start >= 1),
  page_end          int  not null check (page_end >= page_start),
  mastery_level     int  not null default 0 check (mastery_level between 0 and 4),
  level_progress    int  not null default 0 check (level_progress >= 0),
  danger_zone       boolean not null default false,
  last_practiced_at timestamptz,
  study_notes       jsonb
);
create table if not exists questions (
  id             uuid primary key default gen_random_uuid(),
  course_id      uuid not null references courses (id) on delete cascade,
  user_id        uuid not null,
  topic_id       uuid not null references topics (id) on delete cascade,
  format         text not null,
  level          int  not null check (level between 1 and 4),
  public_payload jsonb not null,
  source_pages   int[] not null default '{}',
  verified       boolean not null default false,
  created_at     timestamptz not null default now()
);
-- Answer keys: never sent to the browser (no route reads them except grading).
create table if not exists question_keys (
  question_id     uuid primary key references questions (id) on delete cascade,
  user_id         uuid not null,
  private_payload jsonb not null
);
create table if not exists attempts (
  id                uuid primary key default gen_random_uuid(),
  question_id       uuid not null references questions (id) on delete cascade,
  course_id         uuid not null references courses (id) on delete cascade,
  topic_id          uuid not null references topics (id) on delete cascade,
  user_id           uuid not null,
  answer            text not null,
  confidence        text not null check (confidence in ('guessing', 'fairly_sure', 'very_sure')),
  hint_used         boolean not null default false,
  verdict           text not null check (verdict in ('correct', 'partial', 'incorrect')),
  score             numeric not null check (score between 0 and 1),
  key_point_results jsonb,
  mistake_type      text,
  feedback          jsonb,
  created_at        timestamptz not null default now()
);
-- detail must never contain note or answer text.
create table if not exists safety_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  course_id  uuid references courses (id) on delete cascade,
  type       text not null,
  detail     jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists courses_user_id_idx         on courses (user_id);
create index if not exists courses_created_at_idx      on courses (created_at);
create index if not exists pages_course_id_idx         on pages (course_id);
create index if not exists chunks_course_id_idx        on chunks (course_id);
create index if not exists topics_course_id_idx        on topics (course_id);
create index if not exists questions_course_id_idx     on questions (course_id);
create index if not exists questions_topic_id_idx      on questions (topic_id);
create index if not exists attempts_course_id_idx      on attempts (course_id);
create index if not exists attempts_topic_id_idx       on attempts (topic_id);
create index if not exists safety_events_user_id_idx   on safety_events (user_id);
-- No HNSW index on purpose: see docs/DECISIONS.md (exact search per course).
`;

let pool: Pool | null = null;
let ready: Promise<void> | null = null;
let lastCleanup = 0;

export function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  }
  return pool;
}

/** Creates the tables on first use (not at start-up, so /api/health works without a database). */
export async function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = getPool()
      .query(SCHEMA)
      .then(() => undefined)
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  return ready;
}

/**
 * Deletes courses (and with them their pages, chunks, topics, questions and attempts)
 * older than NOTES_TTL_HOURS, and old safety events. Rides on ordinary requests, at most
 * once a minute per instance: Cloud Run runs nothing between requests, so there is no cron.
 */
export async function cleanupExpired(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastCleanup < 60_000) return;
  lastCleanup = now;
  const secs = NOTES_TTL_HOURS * 3600;
  await getPool().query("delete from courses where created_at < now() - make_interval(secs => $1)", [secs]);
  await getPool().query("delete from safety_events where created_at < now() - make_interval(secs => $1)", [secs]);
}
