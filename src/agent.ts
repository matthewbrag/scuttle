import fs from "node:fs";
import path from "node:path";
import { provider, summarize, getCtxMax, ContextExceededError, ToolCallParseError } from "./model";
import type { ChatStats } from "./model";
import { tools, executeTool, resolveProjectFile } from "./tools";
import { appendMessage, readMessages, readMeta, updateMeta } from "./store";
import { buildMessages, maybeCompact, compact } from "./compaction";
import { ensureContainer } from "./container";
import { MAX_STEPS, ATTACHMENT_TEXT_INLINE_MAX_BYTES } from "./config";
import type { Message, ContentPart, UploadedAttachment, SessionMeta } from "./types";
import { textOf } from "./types";
import { recordAttachments } from "./attachments";
import type { AgentEvent } from "./events";

export interface UserInput {
  text: string;
  attachments?: UploadedAttachment[];
}

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".csv", ".yaml", ".yml", ".py", ".js", ".jsx", ".ts", ".tsx",
  ".html", ".css", ".log", ".xml", ".toml", ".ini", ".sh", ".c", ".cpp", ".h", ".rs",
  ".go", ".java", ".rb", ".php", ".sql",
]);
const isTextLike = (a: UploadedAttachment) => a.mime.startsWith("text/") || TEXT_EXTENSIONS.has(path.extname(a.name).toLowerCase());

/** Turns the attachments the PWA already uploaded (see POST /sessions/:id/upload) into
 * the content parts the MODEL actually needs — images inline as base64 (same precedent
 * as view_image's tool-result content), small text files inlined verbatim, anything else
 * (a PDF, a big file) left as a short pointer note since the agent can read it itself
 * with run_bash once it knows the path is there. */
function buildAttachmentParts(meta: SessionMeta, attachments: UploadedAttachment[]): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const a of attachments) {
    const abs = resolveProjectFile(meta, a.relPath);
    if (a.mime.startsWith("image/")) {
      if (abs && fs.existsSync(abs)) {
        const b64 = fs.readFileSync(abs).toString("base64");
        parts.push({ type: "image_url", image_url: { url: `data:${a.mime};base64,${b64}` } });
      }
    } else if (isTextLike(a) && a.size <= ATTACHMENT_TEXT_INLINE_MAX_BYTES && abs && fs.existsSync(abs)) {
      const text = fs.readFileSync(abs, "utf8");
      parts.push({ type: "text", text: `--- attached: ${a.name} ---\n${text}` });
    } else {
      parts.push({
        type: "text",
        text: `[attached: ${a.name} (${a.mime}, ${a.size} bytes) at ${a.relPath} — use your tools to inspect it]`,
      });
    }
  }
  return parts;
}

const SYSTEM_PROMPT = `You are Scuttle, an autonomous coding agent working inside a sandboxed container.
The project is at the current working directory. Use the run_bash tool to inspect and modify
files, run commands, install dependencies, and complete the user's request. Work step by step,
verifying as you go. When the task is complete, reply with a short summary and DO NOT call a tool.`;

/** A one-off steering note for the TOOL_CALL_PARSE_ERROR retry below — appended to the
 * prompt for that single retry call only, never persisted to fullHistory/transcript.jsonl
 * (same "prompt-construction-only" trick compaction checkpoints use). */
const TOOL_CALL_PARSE_RETRY_HINT: Message = {
  role: "user",
  content:
    "Your last tool call's arguments failed to parse as JSON (likely a stray unescaped quote or raw " +
    "newline inside a long multi-line string, e.g. a Python heredoc). Try again — if the command " +
    "involves a long or complex script, consider writing it in smaller steps instead of one large " +
    "inline block, which is easier to emit as valid JSON.",
};

/** Calls the model with the CURRENT (possibly compacted) prompt built from `fullHistory`.
 * Two specific failure modes get ONE automatic retry before propagating to the normal
 * catch below — neither is a generic "something broke," both are cases agent.ts knows
 * how to react to:
 *  - context-exceeded: force an emergency compaction and retry with a smaller prompt,
 *    a backstop for when something jumps the threshold in one shot (a huge tool result,
 *    a big image), faster than the proactive post-turn check below can catch it.
 *  - malformed tool-call JSON: retry with a steering hint appended (see above) — seen in
 *    practice to recur at the exact same point on a bare retry (near-deterministic at low
 *    temperature), so nudging the prompt gives it a different path to actually dodge it. */
async function chatWithCompactionRetry(
  sessionId: string,
  fullHistory: Message[],
  onDelta: (d: { content?: string; reasoning?: string }) => void,
  signal: AbortSignal | undefined,
  emit: (e: AgentEvent) => void,
) {
  const attempt = (history: Message[] = fullHistory) =>
    provider.chat(buildMessages(SYSTEM_PROMPT, sessionId, history), tools, onDelta, signal);
  try {
    return await attempt();
  } catch (e) {
    if (e instanceof ContextExceededError) {
      emit({ type: "compacting" });
      const compacted = await compact(sessionId, fullHistory);
      if (compacted) emit({ type: "compacted", throughIndex: fullHistory.length });
      return await attempt(); // if this also throws, it propagates to the normal catch below
    }
    if (e instanceof ToolCallParseError) {
      emit({ type: "retry", reason: "model's tool call had malformed JSON arguments — retrying once" });
      return await attempt([...fullHistory, TOOL_CALL_PARSE_RETRY_HINT]);
    }
    throw e;
  }
}

/** Run one user turn to completion, emitting events. Tools execute in the session's container.
 * `signal`, when aborted (Ctrl+C → /cancel), interrupts the in-flight model call or tool exec
 * and ends the turn early with a "cancelled" event — the partial assistant reply is NOT
 * persisted, so the next turn starts clean from the last complete message, not a half-formed
 * one. Only this one turn is affected; anything else already queued still runs afterward. */
export async function runTurn(
  sessionId: string,
  input: UserInput,
  emit: (e: AgentEvent) => void,
  signal?: AbortSignal,
) {
  const meta = readMeta(sessionId);
  if (!meta) {
    emit({ type: "error", message: "no such session" });
    return;
  }

  try {
    await ensureContainer(meta);
  } catch (e: any) {
    emit({ type: "error", message: `container: ${e.message}` });
    return;
  }

  const prior = readMessages(sessionId);
  const attachments = input.attachments ?? [];

  // No attachments → content stays a plain string, same shape as every message before
  // this feature existed. Only reaches for ContentPart[] when there's actually something
  // to attach, so the common text-only turn is byte-for-byte what it always was.
  const attachmentParts = attachments.length ? buildAttachmentParts(meta, attachments) : [];
  const content: Message["content"] = attachmentParts.length
    ? [...(input.text.trim() ? [{ type: "text" as const, text: input.text }] : []), ...attachmentParts]
    : input.text;

  appendMessage(sessionId, { role: "user", content });

  // Images show as their own inline block in the UI (runtime.ts's live "user" event
  // carries only the caption + non-image "📎 name" notes, mirroring this). Recorded here
  // regardless of type so a later reconnect can rebuild the exact same display instead of
  // re-deriving it from the message content, which mixes the caption with whatever got
  // inlined for the MODEL (see attachments.ts's doc comment).
  const userMessageSeq = prior.filter((m) => m.role === "user").length;
  for (const a of attachments) {
    if (a.mime.startsWith("image/")) emit({ type: "image", url: `/sessions/${sessionId}/files/${a.relPath}`, caption: a.name });
  }
  recordAttachments(
    sessionId,
    attachments.map((a) => ({ userMessageSeq, relPath: a.relPath, name: a.name, mime: a.mime })),
  );

  // First message → generate the session label (fire and forget). An attachment-only
  // first message (no typed caption) still needs something to summarize.
  if (!prior.some((m) => m.role === "user")) {
    const label = input.text.trim() || (attachments.length ? `(${attachments.map((a) => a.name).join(", ")})` : "");
    summarize(label)
      .then((s) => s && updateMeta(sessionId, { summary: s }))
      .catch(() => {});
  }

  // Mirrors exactly what's been appended to the persisted transcript (never compacted
  // itself — that's purely a prompt-construction concern, see compaction.ts). Indices
  // into this array are what compaction checkpoints are keyed on.
  const fullHistory: Message[] = [...prior, { role: "user", content }];

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) {
      emit({ type: "cancelled" });
      return;
    }

    let assistant: Message;
    let stats: ChatStats | undefined;
    const t0 = Date.now();
    try {
      // Deltas stream live via `emit` as the model generates; the awaited result is
      // the fully assembled message, used for persistence and the tool-call loop below.
      const result = await chatWithCompactionRetry(
        sessionId,
        fullHistory,
        (d) => {
          if (d.content || d.reasoning) emit({ type: "assistant_delta", content: d.content, reasoning: d.reasoning });
        },
        signal,
        emit,
      );
      assistant = result.message;
      stats = result.stats;
    } catch (e: any) {
      if (signal?.aborted) {
        emit({ type: "cancelled" });
        return;
      }
      console.error(`[runTurn] model call failed for session ${sessionId}:`, e);
      emit({ type: "error", message: e.message });
      return;
    }

    const ctxMax = await getCtxMax();
    if (stats) {
      emit({ type: "model_stats", ...stats, ctxMax, elapsedMs: Date.now() - t0, step: step + 1 });
    }

    appendMessage(sessionId, assistant);
    fullHistory.push(assistant);

    // Proactive: react to the REAL measured prompt size from the call that just
    // completed, ahead of the NEXT call (this turn's next tool-loop step, or next turn).
    if (await maybeCompact(sessionId, stats?.promptTokens, ctxMax, fullHistory, () => emit({ type: "compacting" }))) {
      emit({ type: "compacted", throughIndex: fullHistory.length });
    }

    if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
      emit({ type: "done" });
      return;
    }

    for (const tc of assistant.tool_calls) {
      if (signal?.aborted) {
        emit({ type: "cancelled" });
        return;
      }
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        /* leave args empty */
      }
      emit({ type: "tool_call", name: tc.function.name, args: tc.function.arguments });
      const result = await executeTool(meta, tc.function.name, args, signal, emit);
      if (signal?.aborted) {
        emit({ type: "cancelled" });
        return;
      }
      // tool_result's event is always display text, even when the actual tool result
      // (e.g. view_image) carries an image — the image bytes go to the MODEL via
      // `fullHistory` below, not over the event bus (no reason to push a base64 blob
      // through SSE to a client that can't even use it for this particular event type).
      emit({ type: "tool_result", name: tc.function.name, result: textOf(result) });

      const toolMsg: Message = { role: "tool", tool_call_id: tc.id, name: tc.function.name, content: result };
      appendMessage(sessionId, toolMsg);
      fullHistory.push(toolMsg);
    }
  }

  emit({ type: "error", message: `hit max steps (${MAX_STEPS})` });
}
