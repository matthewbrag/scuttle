import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR } from "./config";
import type { SessionMeta, Message } from "./types";

// The filesystem IS the database. Flat, global list; one directory per session.

function ensureDir(d: string) {
  fs.mkdirSync(d, { recursive: true });
}
const sessionDir = (id: string) => path.join(SESSIONS_DIR, id);
const metaPath = (id: string) => path.join(sessionDir(id), "session.json");
const transcriptPath = (id: string) => path.join(sessionDir(id), "transcript.jsonl");

export function newId(): string {
  return "s_" + crypto.randomBytes(6).toString("hex");
}

export function createSession(
  id: string,
  projectPath: string,
  model: string,
  container: string,
  gpu: string,
): SessionMeta {
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    id,
    projectPath,
    model,
    container,
    gpu,
    summary: "",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  saveMeta(meta);
  return meta;
}

export function saveMeta(meta: SessionMeta) {
  meta.updatedAt = new Date().toISOString();
  ensureDir(sessionDir(meta.id));
  fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2));
}

export function updateMeta(id: string, patch: Partial<SessionMeta>): SessionMeta | null {
  const meta = readMeta(id);
  if (!meta) return null;
  Object.assign(meta, patch);
  saveMeta(meta);
  return meta;
}

export function readMeta(id: string): SessionMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}

export function listSessions(): SessionMeta[] {
  ensureDir(SESSIONS_DIR);
  return fs
    .readdirSync(SESSIONS_DIR)
    .map(readMeta)
    .filter((m): m is SessionMeta => !!m)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteSession(id: string) {
  fs.rmSync(sessionDir(id), { recursive: true, force: true });
}

export function appendMessage(id: string, msg: Message) {
  ensureDir(sessionDir(id));
  fs.appendFileSync(transcriptPath(id), JSON.stringify(msg) + "\n");
}

export function readMessages(id: string): Message[] {
  try {
    return fs
      .readFileSync(transcriptPath(id), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Message);
  } catch {
    return [];
  }
}

/** Repairs any session left with a dangling tool_call — the server died mid-exec (e.g.
 * a restart while a command was still running), so nothing ever appended the matching
 * tool result. Left alone, this is actively dangerous, not just cosmetic: the NEXT turn
 * would hand the model a malformed history (a tool_call with no response, which most
 * OpenAI-compatible APIs reject outright), and the UI would show that tool card as
 * "running" forever since nothing will ever complete it. Run once at server startup —
 * a no-op for every session that shut down cleanly. */
export function repairDanglingToolCalls(): number {
  let repaired = 0;
  for (const meta of listSessions()) {
    const messages = readMessages(meta.id);
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || !last.tool_calls?.length) continue;
    const answeredIds = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    for (const tc of last.tool_calls) {
      if (answeredIds.has(tc.id)) continue;
      appendMessage(meta.id, {
        role: "tool",
        tool_call_id: tc.id,
        name: tc.function.name,
        content:
          "error: interrupted — the Scuttle server restarted while this command was running, " +
          "so it never finished and the result was lost. Re-run it if you still need it.",
      });
      repaired++;
    }
  }
  return repaired;
}
