export interface Indicator {
  value: string;
  goal?: string;
  trend?: "up" | "down";
}

export interface SessionMeta {
  id: string;
  projectPath: string;
  model: string;
  container: string;
  gpu: string; // "1", "all", "none", ...
  summary: string; // short human label, auto-generated from the first message
  status: "running" | "stopped";
  createdAt: string;
  updatedAt: string;
  /** set_metric/clear_metric tool state — CURRENT values (not a log), keyed by name.
   * Lives on session.json (not the transcript) since it's mutable state, not an
   * append-only event — a reconnecting client just needs "what is it right now". */
  indicators?: Record<string, Indicator>;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A file saved via POST /sessions/:id/upload, relative to the session's project dir.
 * Travels from the PWA's upload response into the follow-up /input call. */
export interface UploadedAttachment {
  relPath: string;
  mime: string;
  name: string;
  size: number;
}

/** OpenAI multimodal content part. Verified against llama-server/Qwen3: works both in a
 * `user` message AND directly as a `tool` result's content — no synthetic extra user
 * message needed for view_image to feed an image back to the model. */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** OpenAI chat-completions message shape — stored verbatim in transcript.jsonl. */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  /** Qwen3/llama-server sends reasoning as its own field, not <think> tags in content. */
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** Just the text portion of a message's content — for replay/display contexts that
 * don't need (or can't use) the raw image bytes, e.g. re-deriving SSE events from a
 * persisted transcript for a late-joining client. */
export function textOf(content: string | ContentPart[] | null): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : "[image]"))
    .join(" ")
    .trim();
}
