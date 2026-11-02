import "server-only";
import { embedOne } from "@/lib/ai/openrouter";
import { spendLLMCalls } from "@/lib/safety/limits";
import type { UserContext } from "@/lib/db/context";

export type RetrievedChunk = { page_number: number; content: string; similarity: number };

// Embeds the query and returns the top chunks for this course (RLS applies:
// match_chunks is security invoker). `extraPages` adds chunks from pages the
// student named explicitly ("what does page 4 say?").
export async function retrieveChunks(
  ctx: UserContext,
  courseId: string,
  query: string,
  opts: { count?: number; extraPages?: number[] } = {},
): Promise<RetrievedChunk[]> {
  await spendLLMCalls({ ...ctx, courseId });
  const vector = await embedOne(query);
  const { data, error } = await ctx.db.rpc("match_chunks", {
    p_course_id: courseId,
    p_query: vector,
    p_count: opts.count ?? 6,
  });
  if (error) throw error;
  const chunks = ((data ?? []) as RetrievedChunk[]).map((c) => ({
    page_number: c.page_number,
    content: c.content,
    similarity: c.similarity,
  }));

  if (opts.extraPages && opts.extraPages.length > 0) {
    const { data: extra, error: extraError } = await ctx.db
      .from("chunks")
      .select("page_number, content")
      .eq("course_id", courseId)
      .in("page_number", opts.extraPages)
      .limit(6);
    if (extraError) throw extraError;
    for (const c of extra ?? []) {
      if (!chunks.some((x) => x.content === c.content)) {
        chunks.push({ page_number: c.page_number, content: c.content, similarity: 1 });
      }
    }
  }
  return chunks;
}
