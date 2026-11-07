import { useSyncExternalStore } from "react";
import { sessionId } from "@/lib/api-client";

type SessionState = "loading" | "ready" | "error";

const subscribe = () => () => {};

function snapshot(): SessionState {
  try {
    sessionId(); // creates this browser's anonymous id on first use (idempotent)
    return "ready";
  } catch {
    return "error";
  }
}

// Client hook: makes sure this browser has its anonymous session id (no sign-in).
// "loading" during server rendering, "ready" in the browser, so pages wait for it
// before calling the API.
export function useSession(): SessionState {
  return useSyncExternalStore(subscribe, snapshot, () => "loading");
}
