import type { AgentEvent } from "../../src/events";
import type { UploadedAttachment } from "../../src/types";

// Same-origin: server.ts serves this app's static build AND the API from one process,
// so a relative base is all that's needed — no CORS, no separate host to configure.
const BASE = "";

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export const health = () => api("GET", "/health");
export const listSessions = () => api("GET", "/sessions");
export const createSession = (projectPath: string) => api("POST", "/sessions", { projectPath });
export const sendInput = (id: string, text: string, attachments?: UploadedAttachment[]) =>
  api("POST", `/sessions/${id}/input`, { text, attachments });

export interface BrowseEntry {
  name: string;
  isDir: boolean;
}
export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}
export const browseDir = (dirPath?: string): Promise<BrowseResult> =>
  api("GET", `/browse${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ""}`);
export const makeDir = (dirPath: string, name: string): Promise<{ path: string }> =>
  api("POST", "/browse/mkdir", { path: dirPath, name });

/** Uploads one file's raw bytes (no multipart — the browser just PUTs the File directly,
 * which works since File implements Blob) into the session's project dir. */
export async function uploadFile(id: string, file: File): Promise<UploadedAttachment> {
  const res = await fetch(`${BASE}/sessions/${id}/upload?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}
export const stopSession = (id: string) => api("POST", `/sessions/${id}/stop`);
export const cancelSession = (id: string) => api("POST", `/sessions/${id}/cancel`);
export const compactSession = (id: string) => api("POST", `/sessions/${id}/compact`);
export const rmSession = (id: string) => api("DELETE", `/sessions/${id}`);

/** Subscribe to a session's event stream. Browsers get this for free via the native
 * EventSource API — no manual SSE line-parsing needed (unlike the TUI, which has to
 * hand-roll it since Node's fetch doesn't include an EventSource implementation).
 * Returns an unsubscribe function. `onOpen` fires once the connection is confirmed —
 * same race-avoidance contract as tui/api.ts's streamSession: callers that need to
 * send input right after attaching should await/use onOpen first. */
export function streamSession(id: string, onEvent: (e: AgentEvent) => void, onOpen?: () => void): () => void {
  const es = new EventSource(`/sessions/${id}/stream`);
  es.onopen = () => onOpen?.();
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as AgentEvent);
    } catch {
      /* ignore malformed line */
    }
  };
  return () => es.close();
}
