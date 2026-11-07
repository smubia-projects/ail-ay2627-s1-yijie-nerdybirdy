import "server-only";
import type { Pool } from "pg";

/**
 * A small stand-in for the Supabase query builder, scoped to one anonymous user.
 *
 * Supabase enforced ownership with RLS (`user_id = auth.uid()` on every table). Neon has
 * no auth service, so this builder does the same job in code: EVERY statement it builds
 * carries `user_id = $1` with the session's id (selects, updates, deletes, the embedded
 * `questions(format)` join, and match_chunks), and every insert or upsert writes the
 * session's id as user_id, whatever the row says. A query cannot be built without it,
 * so a forgotten filter can't leak another visitor's notes (tests/scoped-db.test.ts).
 *
 * Supported, because the app uses exactly these: from(t).select(cols, {count, head})
 * .eq/.in/.gte/.lte/.order/.limit/.single/.maybeSingle, insert(...).select().single(),
 * upsert(rows, {onConflict}), update(values).eq(...), delete().eq/.in, rpc("match_chunks").
 * Results have Supabase's shape: { data, error, count }.
 */

// Rows are untyped, as with the untyped Supabase client the lib/ code was written against.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// pg errors carry a code (e.g. 42703 undefined column), as PostgREST errors did.
export type DbError = Error & { code?: string };
export type Result<T = Row> = { data: T; error: DbError | null; count: number | null };
type Query = { text: string; values: unknown[] };
export type Runner = (q: Query) => Promise<{ rows: Row[]; rowCount: number | null }>;

const TABLES = new Set([
  "courses", "pages", "chunks", "topics", "questions", "question_keys", "attempts", "safety_events",
]);
// Columns stored as jsonb: serialised on write (an array value would otherwise become a Postgres array).
const JSONB: Record<string, string[]> = {
  topics: ["study_notes"],
  questions: ["public_payload"],
  question_keys: ["private_payload"],
  attempts: ["key_point_results", "feedback"],
  safety_events: ["detail"],
};
const IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Invalid identifier: ${name}`);
  return `"${name}"`;
}

function encode(table: string, col: string, value: unknown): unknown {
  if (col === "embedding" && Array.isArray(value)) return `[${value.join(",")}]`;
  if (JSONB[table]?.includes(col) && value !== null && value !== undefined) return JSON.stringify(value);
  return value;
}

class Builder<T = Row[]> implements PromiseLike<Result<T>> {
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private cols = "*";
  private embed: { table: string; cols: string[] } | null = null;
  private countOnly = false;
  private wantCount = false;
  private filters: { sql: string; value: unknown }[] = [];
  private orders: string[] = [];
  private max: number | null = null;
  private one: "single" | "maybe" | null = null;
  private rows: Row[] = [];
  private conflict: string[] = [];
  private values: Row = {};
  private returning = false;

  constructor(
    private run: Runner,
    private userId: string,
    private table: string,
  ) {
    if (!TABLES.has(table)) throw new Error(`Unknown table: ${table}`);
  }

  select(cols = "*", opts: { count?: "exact"; head?: boolean } = {}): this {
    if (this.op === "select") {
      const parts = cols.split(",").map((c) => c.trim()).filter(Boolean);
      const plain: string[] = [];
      for (const p of parts) {
        const m = /^([a-z_]+)\(([a-z_, ]+)\)$/.exec(p);
        if (m) this.embed = { table: m[1], cols: m[2].split(",").map((c) => c.trim()) };
        else plain.push(p);
      }
      this.cols = plain.length ? plain.map((c) => (c === "*" ? "t.*" : `t.${ident(c)}`)).join(", ") : "t.*";
      this.wantCount = opts.count === "exact";
      this.countOnly = Boolean(opts.head);
    } else {
      this.returning = true;
      this.cols = cols === "*" ? "*" : cols.split(",").map((c) => ident(c.trim())).join(", ");
    }
    return this;
  }

  insert(rows: Row | Row[]): this {
    this.op = "insert";
    this.rows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  upsert(rows: Row | Row[], opts: { onConflict: string }): this {
    this.op = "upsert";
    this.rows = Array.isArray(rows) ? rows : [rows];
    this.conflict = opts.onConflict.split(",").map((c) => c.trim());
    return this;
  }

  update(values: Row): this {
    this.op = "update";
    this.values = values;
    return this;
  }

  delete(): this {
    this.op = "delete";
    return this;
  }

  private filter(col: string, sqlOp: string, value: unknown): this {
    this.filters.push({ sql: `${this.alias()}${ident(col)} ${sqlOp}`, value });
    return this;
  }

  private alias(): string {
    return this.op === "select" ? "t." : "";
  }

  eq(col: string, value: unknown) { return this.filter(col, "= $?", value); }
  gte(col: string, value: unknown) { return this.filter(col, ">= $?", value); }
  lte(col: string, value: unknown) { return this.filter(col, "<= $?", value); }
  lt(col: string, value: unknown) { return this.filter(col, "< $?", value); }
  in(col: string, values: unknown[]) { return this.filter(col, "= any($?)", values); }

  order(col: string, opts: { ascending?: boolean } = {}): this {
    this.orders.push(`${this.alias()}${ident(col)} ${opts.ascending === false ? "desc" : "asc"}`);
    return this;
  }

  limit(n: number): this {
    this.max = Math.max(0, Math.floor(n));
    return this;
  }

  // One row, untyped like the Supabase client's (callers pass it on to typed helpers).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  single(): Builder<any> {
    this.one = "single";
    return this as never;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  maybeSingle(): Builder<any> {
    this.one = "maybe";
    return this as never;
  }

  /** The SQL this builder runs, with the user filter always first ($1). Exposed for tests. */
  toSQL(): Query {
    const values: unknown[] = [this.userId];
    const param = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };
    const where = () =>
      [`${this.alias()}"user_id" = $1`, ...this.filters.map((f) => f.sql.replace("$?", param(f.value)))].join(" and ");
    const t = ident(this.table);

    if (this.op === "select") {
      let from = `${t} t`;
      let cols = this.countOnly ? "count(*)::int as count" : this.cols;
      if (this.embed && !this.countOnly) {
        const e = this.embed;
        if (!(this.table === "attempts" && e.table === "questions")) throw new Error(`Unsupported embed: ${e.table}`);
        // The embedded row must belong to the same user too.
        from += ` left join "questions" e on e."id" = t."question_id" and e."user_id" = $1`;
        cols += `, case when e."id" is null then null else json_build_object(${e.cols
          .map((c) => `'${c}', e.${ident(c)}`)
          .join(", ")}) end as "${e.table}"`;
      }
      let sql = `select ${cols} from ${from} where ${where()}`;
      if (this.orders.length && !this.countOnly) sql += ` order by ${this.orders.join(", ")}`;
      if (this.max !== null && !this.countOnly) sql += ` limit ${this.max}`;
      return { text: sql, values };
    }

    if (this.op === "insert" || this.op === "upsert") {
      if (this.rows.length === 0) throw new Error("Nothing to insert");
      const cols = [...new Set(this.rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== "user_id");
      const tuples = this.rows.map(
        (r) => `($1, ${cols.map((c) => (c in r ? param(encode(this.table, c, r[c])) : "default")).join(", ")})`,
      );
      let sql = `insert into ${t} ("user_id", ${cols.map(ident).join(", ")}) values ${tuples.join(", ")}`;
      if (this.op === "upsert") {
        const set = cols.filter((c) => !this.conflict.includes(c)).map((c) => `${ident(c)} = excluded.${ident(c)}`);
        // Only rows this user owns may be overwritten.
        sql += ` on conflict (${this.conflict.map(ident).join(", ")}) do update set ${set.join(", ")} where ${t}."user_id" = $1`;
      }
      if (this.returning) sql += ` returning ${this.cols}`;
      return { text: sql, values };
    }

    if (this.op === "update") {
      const cols = Object.keys(this.values).filter((c) => c !== "user_id");
      const set = cols.map((c) => `${ident(c)} = ${param(encode(this.table, c, this.values[c]))}`);
      let sql = `update ${t} set ${set.join(", ")} where ${where()}`;
      if (this.returning) sql += ` returning ${this.cols}`;
      return { text: sql, values };
    }

    let sql = `delete from ${t} where ${where()}`;
    if (this.returning) sql += ` returning ${this.cols}`;
    return { text: sql, values };
  }

  private async execute(): Promise<Result<T>> {
    try {
      const { rows, rowCount } = await this.run(this.toSQL());
      if (this.op === "select" && this.countOnly) {
        return { data: null as T, error: null, count: Number(rows[0]?.count ?? 0) };
      }
      const count = this.wantCount ? rows.length : null;
      if (this.one) {
        if (rows.length > 1 || (this.one === "single" && rows.length === 0)) {
          return { data: null as T, error: new Error(`Expected one row, got ${rows.length}`), count };
        }
        return { data: (rows[0] ?? null) as T, error: null, count };
      }
      const writing = this.op !== "select" && !this.returning;
      return { data: (writing ? null : rows) as T, error: null, count: writing ? rowCount : count };
    } catch (err) {
      return { data: null as T, error: err instanceof Error ? err : new Error(String(err)), count: null };
    }
  }

  then<A = Result<T>, B = never>(
    onfulfilled?: ((value: Result<T>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export type ScopedDb = {
  from: (table: string) => Builder;
  rpc: (fn: "match_chunks", args: { p_course_id: string; p_query: number[]; p_count?: number }) => Promise<Result<Row[]>>;
};

/** match_chunks from the Supabase migration, with the user filter added (was RLS via security invoker). */
export function matchChunksSQL(userId: string, courseId: string, query: number[], count = 6): Query {
  return {
    text:
      `select c."id" as chunk_id, c."page_number", c."content", 1 - (c."embedding" <=> $3::vector) as similarity ` +
      `from "chunks" c where c."user_id" = $1 and c."course_id" = $2 ` +
      `order by c."embedding" <=> $3::vector limit $4`,
    values: [userId, courseId, `[${query.join(",")}]`, Math.min(Math.max(count, 1), 20)],
  };
}

export function scopedDb(run: Runner | Pool, userId: string): ScopedDb {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Invalid user id");
  const runner: Runner = typeof run === "function" ? run : (q) => run.query(q.text, q.values);
  return {
    from: (table) => new Builder(runner, userId, table),
    rpc: async (fn, args) => {
      if (fn !== "match_chunks") throw new Error(`Unknown function: ${fn}`);
      try {
        const { rows } = await runner(matchChunksSQL(userId, args.p_course_id, args.p_query, args.p_count));
        return { data: rows, error: null, count: null };
      } catch (err) {
        return { data: [], error: err instanceof Error ? err : new Error(String(err)), count: null };
      }
    },
  };
}
