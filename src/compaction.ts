import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR, COMPACTION_THRESHOLD, COMPACTION_KEEP_RECENT } from "./config";
import { provider } from "./model";
import { textOf, type Message } from "./types";

/**
 * Context compaction: once the real (measured, not estimated — see model_stats)
 * prompt_tokens crosses COMPACTION_THRESHOLD of ctxMax, summarize everything except the
 * most recent COMPACTION_KEEP_RECENT messages into a persisted checkpoint, and use that
 * summary + the recent tail as the prompt instead of the full history.
 *
 * Deliberately does NOT touch transcript.jsonl — the full, uncompacted history stays
 * intact there for the human to scroll through (TUI/PWA), exactly as it happened. Only
 * the MODEL's own prompt gets compacted. The checkpoint only ever moves forward: each
 * re-compaction folds the previous summary text + the newly-to-be-summarized messages
 * into one new summary, rather than nesting summaries-of-summaries indefinitely.
 */

export interface Checkpoint {
  summary: string;
  /** prior[] indices [0, throughIndex) are covered by `summary` — an index into the
   * full persisted transcript, which only ever grows by appending, so this stays
   * meaningful across calls even as more messages accumulate after it. */
  throughIndex: number;
}

const checkpointPath = (sessionId: string) => path.join(SESSIONS_DIR, sessionId, "compaction.json");

export function readCheckpoint(sessionId: string): Checkpoint | null {
  try {
    return JSON.parse(fs.readFileSync(checkpointPath(sessionId), "utf8")) as Checkpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(sessionId: string, cp: Checkpoint) {
  fs.mkdirSync(path.dirname(checkpointPath(sessionId)), { recursive: true });
  fs.writeFileSync(checkpointPath(sessionId), JSON.stringify(cp, null, 2));
}

/** The actual messages to send to the model for this turn: system prompt, then (if a
 * checkpoint exists) the summary as a `user`-role message — NOT `system`: verified live
 * that the Qwen3 chat template throws if a second system-role message appears anywhere
 * but position 0 — then whatever history isn't yet covered by the checkpoint. */
export function buildMessages(systemPrompt: string, sessionId: string, fullHistory: Message[]): Message[] {
  const cp = readCheckpoint(sessionId);
  if (!cp) return [{ role: "system", content: systemPrompt }, ...fullHistory];
  const summaryMsg: Message = {
    role: "user",
    content: `[Summary of ${cp.throughIndex} earlier messages in this session, condensed to save context space]\n\n${cp.summary}`,
  };
  return [{ role: "system", content: systemPrompt }, summaryMsg, ...fullHistory.slice(cp.throughIndex)];
}

function describe(m: Message): string {
  const text = textOf(m.content);
  const toolNote = m.tool_calls?.length ? ` [called ${m.tool_calls.map((tc) => tc.function.name).join(", ")}]` : "";
  return `[${m.role}${toolNote}] ${text}`.trim();
}

/** Folds the existing summary (if any) + the newly-in-scope messages into one new
 * summary via the model itself. Returns false if there's nothing new to fold in. */
export async function compact(sessionId: string, fullHistory: Message[]): Promise<boolean> {
  const cp = readCheckpoint(sessionId);
  const startFrom = cp?.throughIndex ?? 0;
  const cutoff = Math.max(startFrom, fullHistory.length - COMPACTION_KEEP_RECENT);
  if (cutoff <= startFrom) return false;

  const toSummarize = fullHistory.slice(startFrom, cutoff).map(describe).join("\n");
  const prompt =
    (cp ? `Existing summary of earlier conversation:\n${cp.summary}\n\n` : "") +
    "Summarize the following coding-agent conversation concisely but completely. Preserve: what the " +
    "user asked for, key decisions made, files created or modified, commands that succeeded or failed " +
    "(and why), and anything the agent explicitly learned or should remember going forward. Be factual " +
    "and dense, not conversational — this replaces the raw history for the agent's own future reference." +
    `\n\n${toSummarize}\n\n/no_think`;

  const { message } = await provider.chat([{ role: "user", content: prompt }]);
  const summary = textOf(message.content).trim();
  if (!summary) return false;

  saveCheckpoint(sessionId, { summary, throughIndex: cutoff });
  return true;
}

/** Proactive trigger — called after each real model_stats measurement. */
export async function maybeCompact(
  sessionId: string,
  promptTokens: number | undefined,
  ctxMax: number | undefined,
  fullHistory: Message[],
): Promise<boolean> {
  if (!promptTokens || !ctxMax) return false;
  if (promptTokens / ctxMax < COMPACTION_THRESHOLD) return false;
  return compact(sessionId, fullHistory);
}
