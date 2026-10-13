import { MODEL_BASE_URL, MODEL_NAME, MODEL_API_KEY } from "./config";
import type { Message, ToolCall } from "./types";
import { textOf } from "./types";

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface Delta {
  content?: string;
  reasoning?: string;
}

/** The prompt itself is too large for the model's context window — distinct from a
 * generic model error so callers can react specifically (compact and retry) rather
 * than just surfacing it as a fatal failure. */
export class ContextExceededError extends Error {}

/** The model generated a tool call whose arguments llama-server couldn't parse as JSON —
 * seen in practice with long multi-line heredoc scripts (a stray unescaped quote/newline
 * in the generated string). Distinct from a generic error so agent.ts can retry once with
 * a steering hint instead of just failing the turn outright. */
export class ToolCallParseError extends Error {}

/** Per-turn model performance, straight from llama-server's own reporting — nothing
 * estimated client-side. `specAccept` is speculative-decoding's draft acceptance rate,
 * when the server is running with a draft model. */
export interface ChatStats {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  tokPerSec?: number;
  promptPerSec?: number;
  specAccept?: number;
}

export interface ChatResult {
  message: Message;
  stats?: ChatStats;
}

/** Interchangeable inference backend. Swap this to target a different provider. */
export interface Provider {
  /** Always streams under the hood; `onDelta` fires per chunk, the promise resolves
   * with the fully assembled message once the response completes. `signal`, if aborted,
   * cancels the in-flight HTTP request (used to interrupt a turn via Ctrl+C). */
  chat(messages: Message[], tools?: ToolSchema[], onDelta?: (d: Delta) => void, signal?: AbortSignal): Promise<ChatResult>;
}

interface PartialToolCall {
  id?: string;
  type?: "function";
  name?: string;
  arguments: string;
}

/** Works against any OpenAI-compatible streaming /v1/chat/completions endpoint
 * (verified against llama-server: reasoning arrives as a separate `delta.reasoning_content`
 * field — NOT <think> tags embedded in content — and tool-call arguments arrive as
 * incremental string fragments keyed by `index`, accumulated here). */
class OpenAICompatProvider implements Provider {
  async chat(messages: Message[], tools?: ToolSchema[], onDelta?: (d: Delta) => void, signal?: AbortSignal): Promise<ChatResult> {
    const body: any = {
      model: MODEL_NAME,
      messages,
      temperature: 0.2,
      stream: true,
      // Without this, llama-server's streaming mode omits `usage` entirely (verified
      // live) — the final chunk only carries `timings`. With it, one extra chunk with
      // choices:[] arrives carrying both usage AND timings.
      stream_options: { include_usage: true },
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    const res = await fetch(`${MODEL_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MODEL_API_KEY}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      // Verified live: llama-server returns a structured 400 with type:"exceed_context_size_error"
      // when the prompt itself is too big — distinct error class so agent.ts's reactive
      // compaction backstop can catch exactly this (and only this) and retry once, rather
      // than treating every model error as fatal.
      let isContextExceeded = false;
      let isToolCallParseError = false;
      try {
        const parsed = JSON.parse(text);
        isContextExceeded = parsed?.error?.type === "exceed_context_size_error";
        isToolCallParseError = typeof parsed?.error?.message === "string" && parsed.error.message.includes("Failed to parse tool call arguments as JSON");
      } catch {
        /* not JSON, or unexpected shape — treat as a normal error below */
      }
      if (isContextExceeded) throw new ContextExceededError(text);
      if (isToolCallParseError) throw new ToolCallParseError(text);
      throw new Error(`model error ${res.status}: ${text}`);
    }
    if (!res.body) throw new Error("model error: empty response body");

    let content = "";
    let reasoning = "";
    const toolCalls = new Map<number, PartialToolCall>();
    let stats: ChatStats | undefined;

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        const line = part.replace(/^data: /, "").trim();
        // SSE comment lines (often a keepalive ping on a slow connection — e.g. a long
        // compaction summarize() call) start with ":" per spec and carry no data; a bare
        // JSON.parse on one of these was an UNCAUGHT exception that crashed the entire
        // Node process, not just this request — seen live, repeatedly, always during
        // compact(). One malformed/unexpected chunk must never be able to take the whole
        // server down, so this is now defensive regardless of the specific cause.
        if (!line || line === "[DONE]" || line.startsWith(":")) continue;
        let chunk: any;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue; // unparseable chunk — skip it, don't crash the turn (or the server)
        }

        if (chunk.usage || chunk.timings) {
          stats = {
            promptTokens: chunk.usage?.prompt_tokens,
            completionTokens: chunk.usage?.completion_tokens,
            cachedTokens: chunk.usage?.prompt_tokens_details?.cached_tokens,
            tokPerSec: chunk.timings?.predicted_per_second,
            promptPerSec: chunk.timings?.prompt_per_second,
            specAccept:
              chunk.timings?.draft_n > 0 ? chunk.timings.draft_n_accepted / chunk.timings.draft_n : undefined,
          };
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          onDelta?.({ content: delta.content });
        }
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onDelta?.({ reasoning: delta.reasoning_content });
        }
        for (const tc of delta.tool_calls ?? []) {
          const existing = toolCalls.get(tc.index) ?? { arguments: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.type) existing.type = tc.type;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          toolCalls.set(tc.index, existing);
        }
      }
    }

    const assembled: ToolCall[] = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => ({
        id: tc.id ?? "",
        type: "function" as const,
        function: { name: tc.name ?? "", arguments: tc.arguments },
      }));

    return {
      message: {
        role: "assistant",
        content,
        reasoning_content: reasoning || undefined,
        tool_calls: assembled.length ? assembled : undefined,
      },
      stats,
    };
  }
}

export const provider: Provider = new OpenAICompatProvider();

/** Cheap one-shot summary for the session label (uses the same provider, no streaming needed). */
export async function summarize(text: string): Promise<string> {
  const { message } = await provider.chat([
    {
      role: "user",
      content:
        "Summarize this coding task in 3-5 words, lowercase, no punctuation. " +
        "Reply with ONLY the summary.\n\n" +
        text +
        " /no_think",
    },
  ]);
  const line = textOf(message.content).trim().split("\n").filter(Boolean).pop() || "";
  return line.replace(/["'.]/g, "").trim().slice(0, 60);
}

let cachedCtxMax: number | undefined;
/** Fetches n_ctx from llama-server's /props once and caches it — this is a server-wide
 * constant (the context window the model was loaded with), not something that changes
 * per-request. Returns undefined (not a guess) if unreachable or not an OpenAI-shaped
 * endpoint that exposes it — a non-llama.cpp provider just won't show a ctx bar. */
export async function getCtxMax(): Promise<number | undefined> {
  if (cachedCtxMax != null) return cachedCtxMax;
  try {
    const base = new URL(MODEL_BASE_URL);
    const res = await fetch(`${base.protocol}//${base.host}/props`);
    if (!res.ok) return undefined;
    const props = await res.json();
    cachedCtxMax = props?.default_generation_settings?.n_ctx ?? props?.n_ctx;
    return cachedCtxMax;
  } catch {
    return undefined;
  }
}
