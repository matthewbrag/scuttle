import { SERVER_PORT } from "../config";
import { getOrCreatePassword, AUTH_USERNAME } from "../auth";
import type { AgentEvent } from "../events";

const BASE = process.env.SCUTTLE_SERVER || `http://127.0.0.1:${SERVER_PORT}`;

// The TUI runs on the same machine as the server (bare `scuttle`), so it can just read
// the same password file directly — no login flow needed for the primary local case.
const AUTH = "Basic " + Buffer.from(`${AUTH_USERNAME}:${getOrCreatePassword()}`).toString("base64");

async function api(method: string, p: string, body?: any) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Authorization: AUTH, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export const health = () => api("GET", "/health");
export const listSessions = () => api("GET", "/sessions");
export const createSession = (projectPath: string) => api("POST", "/sessions", { projectPath });
export const sendInput = (id: string, text: string) => api("POST", `/sessions/${id}/input`, { text });
export const stopSession = (id: string) => api("POST", `/sessions/${id}/stop`);
export const cancelSession = (id: string) => api("POST", `/sessions/${id}/cancel`);
export const compactSession = (id: string) => api("POST", `/sessions/${id}/compact`);
export const rmSession = (id: string) => api("DELETE", `/sessions/${id}`);

/** Subscribe to a session's SSE event stream until aborted. `onOpen` fires once the
 * server has actually registered this connection's listener — the server's handler
 * calls subscribe() synchronously before any await, so by the time `fetch()` resolves
 * (response headers received), the subscription is guaranteed live. Callers that need
 * to send input right after attaching MUST await onOpen first, or risk the session
 * racing its own events to zero listeners (the live-only bug this was built to fix:
 * a fast local-model turn can finish before the SSE handshake completes, and live
 * events — unlike persisted messages — are gone forever once emitted to no one). */
export async function streamSession(
  id: string,
  signal: AbortSignal,
  onEvent: (e: AgentEvent) => void,
  onOpen?: () => void,
) {
  // Whole body, INCLUDING the initial fetch, must be inside one try/catch — an abort
  // firing before the connection even finishes establishing (e.g. a quick /new right
  // after launch) rejects this fetch() too, and an uncaught rejection here is fatal:
  // this function is always called as `void streamSession(...)` (fire-and-forget), so
  // Node treats an unhandled rejection as a crash, taking the whole TUI down with it.
  try {
    const res = await fetch(`${BASE}/sessions/${id}/stream`, { signal, headers: { Authorization: AUTH } });
    onOpen?.();
    if (!res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const p of parts) {
        const line = p.replace(/^data: /, "").trim();
        if (line) onEvent(JSON.parse(line) as AgentEvent);
      }
    }
  } catch {
    /* aborted or connection closed */
  }
}
