import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR } from "./config";
import { execInContainer, killTreeInContainer } from "./container";
import type { SessionMeta } from "./types";

/**
 * Background process management — "run something, keep working, check in later."
 * Launched via plain shell backgrounding (`(cmd) > logfile 2>&1 & echo $!`) and left
 * running after the triggering `docker exec` session ends; verified this actually
 * survives (not just assumed) by reviewing a real session where the agent improvised
 * the exact same pattern by hand (`nohup curl ... &`) and it worked across many
 * subsequent separate exec calls polling for completion.
 *
 * The log lives at a fixed path INSIDE the container (not the bind-mounted project
 * dir, so it doesn't clutter the user's repo) — /tmp persists across stop/start same
 * as everything else in the durable container, just not across a full `rm`.
 *
 * The task RECORD (id, pid, command, log path) is a small JSON file under the
 * session's own directory — same "filesystem is the database" pattern as everything
 * else in Scuttle, so `check_background`/`kill_background` are simple, stateless,
 * re-runnable at any time (no in-memory registry to lose on a server restart).
 */

export interface BackgroundTask {
  id: string;
  command: string;
  pid: string;
  logPath: string;
  startedAt: string;
}

const bgDir = (sessionId: string) => path.join(SESSIONS_DIR, sessionId, "background");
const taskPath = (sessionId: string, id: string) => path.join(bgDir(sessionId), `${id}.json`);

function saveTask(sessionId: string, task: BackgroundTask) {
  fs.mkdirSync(bgDir(sessionId), { recursive: true });
  fs.writeFileSync(taskPath(sessionId, task.id), JSON.stringify(task, null, 2));
}

export function readTask(sessionId: string, id: string): BackgroundTask | null {
  try {
    return JSON.parse(fs.readFileSync(taskPath(sessionId, id), "utf8")) as BackgroundTask;
  } catch {
    return null;
  }
}

export function listTasks(sessionId: string): BackgroundTask[] {
  try {
    return fs
      .readdirSync(bgDir(sessionId))
      .filter((f) => f.endsWith(".json"))
      .map((f) => readTask(sessionId, f.replace(/\.json$/, "")))
      .filter((t): t is BackgroundTask => !!t)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } catch {
    return [];
  }
}

export async function startBackground(meta: SessionMeta, command: string): Promise<BackgroundTask> {
  const id = "bg_" + crypto.randomBytes(4).toString("hex");
  const logPath = `/tmp/scuttle_${id}.log`;
  // The subshell's own stdout/stderr redirect to the log file — only `echo $!` (the
  // backgrounded job's PID) reaches this wrapper call's own (synchronous) stdout.
  const wrapper = `(${command}) > ${logPath} 2>&1 & echo $!`;
  const { stdout, code } = await execInContainer(meta.container, wrapper);
  const pid = stdout.trim().split("\n").pop() ?? "";
  if (code !== 0 || !/^\d+$/.test(pid)) {
    throw new Error(`failed to start background task (exit ${code}): ${stdout}`);
  }
  const task: BackgroundTask = { id, command, pid, logPath, startedAt: new Date().toISOString() };
  saveTask(meta.id, task);
  return task;
}

export async function checkBackground(
  meta: SessionMeta,
  id: string,
  tailLines = 200,
): Promise<{ running: boolean; output: string } | null> {
  const task = readTask(meta.id, id);
  if (!task) return null;
  const MARK = "---SCUTTLE-STATUS---";
  // `kill -0` alone is WRONG here — it only checks "does a process table entry exist",
  // and a ZOMBIE (exited, not yet reaped — this container's PID 1 is plain `sleep
  // infinity`, which never reaps children) still counts as existing. Verified
  // empirically: it reported a finished task as still running. Check the process
  // STATE instead and treat a leading 'Z' (zombie) the same as "doesn't exist".
  const { stdout } = await execInContainer(
    meta.container,
    `tail -n ${tailLines} ${task.logPath} 2>/dev/null; echo ${MARK}; ` +
      `st=$(ps -o stat= -p ${task.pid} 2>/dev/null | tr -d ' '); ` +
      `[ -n "$st" ] && [ "\${st:0:1}" != "Z" ] && echo RUNNING || echo EXITED`,
  );
  const idx = stdout.lastIndexOf(MARK);
  const output = idx === -1 ? stdout : stdout.slice(0, idx).trimEnd();
  const status = idx === -1 ? "" : stdout.slice(idx + MARK.length).trim();
  return { running: status.includes("RUNNING"), output: output || "(no output yet)" };
}

export async function killBackground(meta: SessionMeta, id: string): Promise<boolean> {
  const task = readTask(meta.id, id);
  if (!task) return false;
  await killTreeInContainer(meta.container, task.pid);
  return true;
}
