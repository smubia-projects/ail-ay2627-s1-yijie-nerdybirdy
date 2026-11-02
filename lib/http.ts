import "server-only";
import { LLMError } from "@/lib/ai/openrouter";
import { RateLimitError } from "@/lib/safety/limits";

// An error whose message is safe and friendly enough to show the student.
export class UserFacingError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "UserFacingError";
  }
}

export function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export async function readJSON(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// Maps thrown errors to friendly responses. Logs only error names/codes,
// never note or answer text.
export function routeError(err: unknown, where: string): Response {
  if (err instanceof UserFacingError) return jsonError(err.status, err.message);
  if (err instanceof RateLimitError) return Response.json(err.body, { status: err.status });
  if (err instanceof LLMError) {
    console.error(`[${where}] LLMError`, err.code, err.status ?? "");
    return jsonError(
      502,
      "The professor is having trouble thinking right now 🦉 Please try again in a moment.",
    );
  }
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  console.error(`[${where}]`, err instanceof Error ? err.name : "unknown", code);
  return jsonError(500, "Something went wrong on our side. Please try again.");
}
