import "server-only";
import OpenAI, { APIError } from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { EmbeddingCreateParams } from "openai/resources/embeddings";
import { z } from "zod";

export { EMBED_DIMENSIONS } from "@/lib/db/pool";
import { EMBED_DIMENSIONS } from "@/lib/db/pool";
const EMBED_BATCH = 64;

// Any OpenAI-compatible gateway (API_BASE_URL); the AI Lodge deploy uses apiyi.
const BASE_URL = (process.env.API_BASE_URL || "https://api.apiyi.com/v1").replace(/\/+$/, "");
const IS_OPENROUTER = BASE_URL.includes("openrouter.ai");

// OpenRouter only: route prompts to providers that support every parameter we
// send and that don't collect data. Never remove data_collection silently: if no
// provider is left, callers get an LLMError with code "no_provider".
// sort: "throughput" prefers the fastest providers (provider speed varies a
// lot for reasoning models; see docs/DECISIONS.md). Other gateways reject these fields.
const PROVIDER = { require_parameters: true, data_collection: "deny", sort: "throughput" } as const;
const providerFields = () => (IS_OPENROUTER ? { provider: PROVIDER } : {});

export class LLMError extends Error {
  constructor(
    public code: "no_provider" | "invalid_output" | "empty" | "upstream",
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

/** The first of these env vars that is set (AI Lodge names first, then the original ones). */
function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing env var ${names[0]}`);
}

export function aiConfigured(): boolean {
  return Boolean((process.env.API_KEY || process.env.OPENROUTER_API_KEY || "").trim());
}

export const models = {
  professor: () => requireEnv("MODEL_NAME", "MODEL_PROFESSOR"),
  checker: () => requireEnv("CHECKER_MODEL_NAME", "MODEL_CHECKER"),
  embed: () => requireEnv("EMBEDDING_MODEL_NAME", "MODEL_EMBED"),
};

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const site = process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost:3000";
    client = new OpenAI({
      baseURL: BASE_URL,
      apiKey: requireEnv("API_KEY", "OPENROUTER_API_KEY"),
      // 45 s per attempt; the SDK retries once on 408/409/429/5xx with backoff.
      timeout: 45_000,
      maxRetries: 1,
      defaultHeaders: { "HTTP-Referer": site, "X-Title": "NerdyBirdy" },
    });
  }
  return client;
}

// ---------- JSON chat calls ----------

type Variant = { mode: "json_schema" | "json_object"; reasoning: boolean };

// Which variant worked last time for a model, so we don't repeat rejected calls.
const resolvedVariant = new Map<string, Variant>();

export function getResolvedVariants(): Record<string, Variant> {
  return Object.fromEntries(resolvedVariant);
}

type CallJSONOptions<T extends z.ZodType> = {
  model: string;
  system: string;
  user: string;
  schema: T;
  temperature: number;
  /**
   * Reasoning effort for reasoning models. Defaults to "low" to keep calls
   * fast; dropped automatically if the model/provider doesn't support it.
   */
  reasoning?: "low" | "medium" | "high";
  /** Name for the json_schema response format. */
  name?: string;
  maxTokens?: number;
};

type Message = { role: "system" | "user" | "assistant"; content: string };

export async function callJSON<T extends z.ZodType>(
  opts: CallJSONOptions<T>,
): Promise<z.infer<T>> {
  const jsonSchema = toJSONSchemaForLLM(opts.schema);
  const cacheKey = opts.model;

  const ladder: Variant[] = [
    { mode: "json_schema", reasoning: true },
    { mode: "json_schema", reasoning: false },
    { mode: "json_object", reasoning: false },
  ];
  const cached = resolvedVariant.get(cacheKey);
  // Off OpenRouter, only gpt- models are known to honour a strict json_schema; others
  // (apiyi's Gemini, DeepSeek) start at json_object, with the schema written into the prompt.
  const strictOK = IS_OPENROUTER || opts.model.startsWith("gpt-");
  const variants = cached ? [cached] : strictOK ? ladder : ladder.slice(2);

  const baseMessages = (v: Variant): Message[] => [
    {
      role: "system",
      content:
        v.mode === "json_object"
          ? `${opts.system}\n\nReply with ONLY a JSON object (no code fences) that matches this JSON Schema:\n${JSON.stringify(jsonSchema)}`
          : opts.system,
    },
    { role: "user", content: opts.user },
  ];

  // Step 1: find a variant the provider accepts.
  let variant: Variant | null = null;
  let raw = "";
  let lastError: unknown = null;
  for (const v of variants) {
    try {
      raw = await complete(opts, baseMessages(v), v, jsonSchema);
      variant = v;
      resolvedVariant.set(cacheKey, v);
      break;
    } catch (err) {
      lastError = err;
      if (!isParameterRejection(err)) throw toLLMError(err);
    }
  }
  if (!variant) throw toLLMError(lastError);

  // Step 2: parse + validate, retrying once with the validation error.
  const first = parseAndValidate(raw, opts.schema);
  if (first.ok) return first.data;

  const retryMessages: Message[] = [
    ...baseMessages(variant),
    { role: "assistant", content: raw },
    {
      role: "user",
      content: `Your reply was not valid: ${first.error}\nReply again with ONLY the corrected JSON object.`,
    },
  ];
  const raw2 = await complete(opts, retryMessages, variant, jsonSchema).catch((err) => {
    throw toLLMError(err);
  });
  const second = parseAndValidate(raw2, opts.schema);
  if (second.ok) return second.data;
  // Validation messages name paths and constraints only, never content.
  console.warn(`[callJSON:${opts.name ?? "response"}] invalid output twice:`, second.error.slice(0, 500));
  throw new LLMError("invalid_output", "The model returned invalid JSON twice.");
}

async function complete<T extends z.ZodType>(
  opts: CallJSONOptions<T>,
  messages: Message[],
  variant: Variant,
  jsonSchema: Record<string, unknown>,
): Promise<string> {
  const body = {
    model: opts.model,
    messages,
    // gpt-5 models accept only the default temperature.
    ...(opts.model.startsWith("gpt-5") ? {} : { temperature: opts.temperature }),
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    response_format:
      variant.mode === "json_schema"
        ? {
            type: "json_schema",
            json_schema: { name: opts.name ?? "response", strict: true, schema: jsonSchema },
          }
        : { type: "json_object" },
    // OpenRouter-specific fields (only sent there); the SDK passes them through.
    ...providerFields(),
    ...(variant.reasoning
      ? IS_OPENROUTER
        ? { reasoning: { effort: opts.reasoning ?? "low", exclude: true } }
        : { reasoning_effort: opts.reasoning ?? "low" }
      : // Off OpenRouter, DeepSeek in JSON mode would otherwise think at length (one grading took 74 s).
        !IS_OPENROUTER && /deepseek/i.test(opts.model)
        ? { reasoning_effort: "none" }
        : {}),
  };
  const res = await getClient().chat.completions.create(
    body as unknown as ChatCompletionCreateParamsNonStreaming,
  );
  const content = res.choices[0]?.message?.content;
  if (!content) throw new LLMError("empty", "The model returned an empty reply.");
  return content;
}

function parseAndValidate<T extends z.ZodType>(
  raw: string,
  schema: T,
): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch {
    return { ok: false, error: "The reply was not parseable JSON." };
  }
  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: z.prettifyError(result.error).slice(0, 1500) };
}

export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1];
  // Some models add prose around the object; keep the outermost {...}.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start > 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function toJSONSchemaForLLM(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-07" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

// 400/404 from OpenRouter usually means "no endpoint supports these
// parameters" (json_schema or reasoning). A data-policy rejection is NOT a
// parameter problem, so we never fall back past it.
function isParameterRejection(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  if (err.status !== 400 && err.status !== 404) return false;
  return !isDataPolicyError(err);
}

function isDataPolicyError(err: unknown): boolean {
  return err instanceof APIError && /data policy|data_collection/i.test(err.message);
}

function toLLMError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  if (isDataPolicyError(err)) {
    return new LLMError(
      "no_provider",
      "No provider for this model accepts data_collection: deny.",
      (err as APIError).status,
    );
  }
  if (err instanceof APIError) {
    // Connection errors and timeouts have no status; name them instead.
    const what = err.status ? `HTTP ${err.status}` : err.constructor.name;
    return new LLMError("upstream", `AI gateway request failed (${what}).`, err.status);
  }
  return new LLMError("upstream", "AI gateway request failed.");
}

// ---------- Embeddings ----------

export async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const body = {
      model: models.embed(),
      input: batch,
      encoding_format: "float",
      dimensions: EMBED_DIMENSIONS,
      ...providerFields(),
    };
    let res;
    try {
      res = await getClient().embeddings.create(body as unknown as EmbeddingCreateParams);
    } catch (err) {
      throw toLLMError(err);
    }
    const sorted = [...res.data].sort((a, b) => a.index - b.index);
    if (sorted.length !== batch.length) {
      throw new LLMError("invalid_output", "Embedding count did not match input count.");
    }
    for (const item of sorted) {
      if (item.embedding.length !== EMBED_DIMENSIONS) {
        throw new LLMError(
          "invalid_output",
          `Expected ${EMBED_DIMENSIONS}-dimension embeddings, got ${item.embedding.length}.`,
        );
      }
      out.push(item.embedding);
    }
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
  return vector;
}
