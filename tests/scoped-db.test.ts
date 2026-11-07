// The Supabase RLS port: every statement must be scoped to the session's user.
//   npm test
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { matchChunksSQL, scopedDb, type Runner } from "@/lib/db/scoped";
import { createCourse } from "@/lib/ingest";
import { RateLimitError, spendLLMCalls } from "@/lib/safety/limits";
import { chargeOnce } from "../server/rateLimit";

type Q = { text: string; values: unknown[] };

function recorder(rows: Record<string, unknown>[] = []) {
  const seen: Q[] = [];
  const run: Runner = async (q) => {
    seen.push(q);
    return { rows, rowCount: rows.length };
  };
  return { seen, run };
}

/** The leak check: the user filter is the first parameter and appears in the statement. */
function assertScoped(q: Q, userId: string) {
  assert.equal(q.values[0], userId, q.text);
  assert.match(q.text, /"user_id" = \$1|\(\$1, |"user_id", /, q.text);
  if (/^(select|update|delete)/.test(q.text)) assert.match(q.text, /where ([tc]\.)?"user_id" = \$1/, q.text);
}

test("every builder statement carries the session's user_id", async () => {
  const user = randomUUID();
  const { seen, run } = recorder([{ id: "x", count: 0 }]);
  const db = scopedDb(run, user);
  await db.from("courses").select("id, name").eq("id", randomUUID()).maybeSingle();
  await db.from("courses").select("id", { count: "exact", head: true });
  await db.from("pages").select("page_number, text").eq("course_id", "c").gte("page_number", 1).lte("page_number", 3).order("page_number");
  await db.from("chunks").delete().eq("course_id", "c").in("page_number", [1, 2]);
  await db.from("topics").update({ study_notes: { a: 1 } }).eq("id", "t");
  await db.from("question_keys").select("user_id, private_payload").eq("question_id", "q").maybeSingle();
  await db.from("attempts").select("topic_id, verdict, questions(format)").eq("course_id", "c").order("created_at", { ascending: false }).limit(300);
  await db.from("courses").insert({ name: "x", exam_date: null, page_count: 3 }).select("id").single();
  await db.from("pages").upsert([{ course_id: "c", page_number: 1, text: "t" }], { onConflict: "course_id,page_number" });
  await db.from("safety_events").insert({ type: "x", course_id: null, detail: { pages: [1] } });
  await db.rpc("match_chunks", { p_course_id: "c", p_query: [0.1, 0.2] });
  assert.equal(seen.length, 11);
  for (const q of seen) assertScoped(q, user);
});

test("a row cannot be written as another user", async () => {
  const me = randomUUID();
  const other = randomUUID();
  const { seen, run } = recorder();
  const db = scopedDb(run, me);
  await db.from("courses").insert({ user_id: other, name: "x", page_count: 1 });
  await db.from("courses").update({ user_id: other, name: "y" }).eq("id", "c");
  for (const q of seen) {
    assert.ok(!q.values.includes(other), q.text);
    assertScoped(q, me);
  }
});

test("an upsert only overwrites the user's own rows; the embedded join is scoped too", () => {
  const user = randomUUID();
  const { run } = recorder();
  const db = scopedDb(run, user);
  const upsert = (db.from("pages").upsert([{ course_id: "c", page_number: 1, text: "t" }], { onConflict: "course_id,page_number" }) as unknown as { toSQL(): Q }).toSQL();
  assert.match(upsert.text, /do update set .* where "pages"\."user_id" = \$1$/);
  const embed = (db.from("attempts").select("topic_id, questions(format)") as unknown as { toSQL(): Q }).toSQL();
  assert.match(embed.text, /left join "questions" e on e\."id" = t\."question_id" and e\."user_id" = \$1/);
  const match = matchChunksSQL(user, "c", [1, 2]);
  assert.match(match.text, /where c\."user_id" = \$1 and c\."course_id" = \$2/);
});

test("identifiers and tables are allowlisted", () => {
  const db = scopedDb(recorder().run, randomUUID());
  assert.throws(() => db.from("pg_user"));
  assert.throws(() => (db.from("courses").select("id; drop table courses") as unknown as { toSQL(): Q }).toSQL());
  assert.throws(() => scopedDb(recorder().run, "not-a-uuid"));
});

test("the real lib code runs only scoped statements (two users never share a query)", async () => {
  const a = randomUUID();
  const b = randomUUID();
  for (const user of [a, b]) {
    const { seen, run } = recorder([{ id: randomUUID(), count: 0 }]);
    await createCourse({ db: scopedDb(run, user), userId: user }, { name: "Bio", examDate: null, pageCount: 3 });
    assert.ok(seen.length >= 2);
    for (const q of seen) {
      assertScoped(q, user);
      assert.ok(!q.values.includes(user === a ? b : a));
    }
  }
});

test("jsonb arrays are serialised and embeddings become vector literals", () => {
  const db = scopedDb(recorder().run, randomUUID());
  const q = (db.from("attempts").insert({ key_point_results: [{ point: "p", hit: true }], feedback: null }) as unknown as { toSQL(): Q }).toSQL();
  assert.equal(q.values[1], JSON.stringify([{ point: "p", hit: true }]));
  const c = (db.from("chunks").insert({ course_id: "c", page_number: 1, content: "x", embedding: [0.5, 0.25] }) as unknown as { toSQL(): Q }).toSQL();
  assert.ok(c.values.includes("[0.5,0.25]"));
});

test("the limiter is charged once per request, and its 429/503 bodies pass through", async () => {
  let calls = 0;
  const allow = () => (_req: unknown, _res: unknown, next: () => void) => {
    calls++;
    next();
  };
  const charge = chargeOnce({} as never, "ask", allow as never);
  await spendLLMCalls({ charge });
  await spendLLMCalls({ charge });
  await spendLLMCalls({ charge }, 3);
  assert.equal(calls, 1);

  const over = () => (_req: unknown, res: { status(n: number): { json(b: unknown): void } }) =>
    res.status(429).json({ message: "Rate limit exceeded.", queries_used: 10 });
  await assert.rejects(spendLLMCalls({ charge: chargeOnce({} as never, "quiz", over as never) }), (err: unknown) => {
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.status, 429);
    assert.equal(err.body.queries_used, 10);
    return true;
  });
  const paused = () => (_req: unknown, res: { status(n: number): { json(b: unknown): void } }) =>
    res.status(503).json({ message: "paused" });
  await assert.rejects(spendLLMCalls({ charge: chargeOnce({} as never, "notes", paused as never) }), (err: unknown) =>
    err instanceof RateLimitError && err.status === 503,
  );
  await spendLLMCalls({}); // evals and scripts: no limiter
});
