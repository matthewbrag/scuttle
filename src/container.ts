import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { RUNTIME_IMAGE, CACHE_DIR, DEFAULT_GPU } from "./config";
import type { SessionMeta } from "./types";

const pexec = promisify(execFile);

// The runtime image runs as the non-root `scuttle` user; its HOME is here, and the
// shared cache mounts under it so cached downloads stay owned by the host user.
const CONTAINER_HOME = "/home/scuttle";

export const containerName = (id: string) => `scuttle-${id}`;

async function exists(name: string): Promise<boolean> {
  try {
    await pexec("docker", ["inspect", name]);
    return true;
  } catch {
    return false;
  }
}

async function running(name: string): Promise<boolean> {
  try {
    const { stdout } = await pexec("docker", ["inspect", "-f", "{{.State.Running}}", name]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function gpuArgs(gpu: string): string[] {
  if (!gpu || gpu === "none") return [];
  return ["--gpus", gpu === "all" ? "all" : `device=${gpu}`];
}

/** Create the session's durable container. The writable layer persists across stop/start. */
async function create(meta: SessionMeta): Promise<void> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  await pexec("docker", [
    "run",
    "-d",
    "--name", meta.container,
    "--label", `scuttle.session=${meta.id}`,
    "--label", `scuttle.project=${meta.projectPath}`,
    "-v", `${meta.projectPath}:${meta.projectPath}`,
    "-v", `${CACHE_DIR}:${CONTAINER_HOME}/.cache`,
    "-w", meta.projectPath,
    ...gpuArgs(meta.gpu || DEFAULT_GPU),
    RUNTIME_IMAGE,
    "sleep", "infinity",
  ]);
}

/**
 * Guarantee the container is up and ready for exec. Creates it once; on later
 * calls just `docker start`s the existing one — so everything the agent has
 * installed persists. `rm` only happens on explicit session delete.
 */
export async function ensureContainer(meta: SessionMeta): Promise<void> {
  if (await exists(meta.container)) {
    if (!(await running(meta.container))) await pexec("docker", ["start", meta.container]);
  } else {
    await create(meta);
  }
}

const PID_MARKER = "__SCUTTLE_PID__:";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024; // matches the old execFile maxBuffer this replaced

/**
 * The proven-correct way to actually stop a process tree in this container (see the
 * long comment on execInContainer below for the two failed approaches this replaced).
 * Shared by execInContainer's cancel path AND background.ts's kill_background tool,
 * so there's exactly one place this hard-won logic lives.
 */
export function killTree(pid: string): string {
  return `kids=$(pgrep -P ${pid}); kill -KILL ${pid}; [ -n "$kids" ] && kill -KILL $kids; true`;
}

export async function killTreeInContainer(name: string, pid: string): Promise<void> {
  await pexec("docker", ["exec", name, "bash", "-c", killTree(pid)]).catch(() => {});
}

/**
 * Run a command in the container. On abort, kills the process INSIDE the container by
 * PID, not just the local `docker exec` client — killing the client process does NOT
 * reliably kill what it spawned remotely (verified empirically: a cancelled `sleep 30`
 * kept running in the container for its full duration when this only killed the local
 * client). We print our own PID as the very first line (NO `exec` — that REPLACES the
 * shell with the first sub-command, silently discarding everything after a `;`/`&&` in
 * a compound command; verified empirically too, the hard way), then on abort:
 * negative-PID "kill the process GROUP" is unsafe here (verified: it killed the kill
 * command's own exec session — this container's exec sessions appear to share an
 * overlapping group), and killing the child before the parent races the parent bash
 * (blocked in wait()) immediately resuming to its NEXT statement once the child dies,
 * for ANY reason. So: snapshot the direct children, SIGKILL the bash wrapper FIRST
 * (dead means it cannot execute anything further — no race possible), then SIGKILL the
 * snapshotted children by their own captured PIDs (not `-P` matching, which stops
 * working the instant they're reparented to the container's PID 1).
 */
export function execInContainer(
  name: string,
  command: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const wrapped = `echo ${PID_MARKER}$$; ${command}`;
    const child = spawn("docker", ["exec", name, "bash", "-lc", wrapped]);

    let stdout = "";
    let stderr = "";
    let pidLineConsumed = false;
    let containerPid: string | null = null;
    let killed = false;
    let timedOut = false;

    // Same kill path for both: whether a human cancelled or a timeout fired, the
    // container-side process tree has to die the same hard-won way (see the long
    // comment above) — only the reason differs, tracked separately so the caller can
    // tell the two apart and give the model an actionable message for a timeout.
    const kill = () => {
      killed = true;
      if (containerPid) void killTreeInContainer(name, containerPid);
      child.kill();
    };
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer =
      timeoutMs != null
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, timeoutMs)
        : null;

    // A runaway command (e.g. `yes`) could otherwise grow these strings unboundedly —
    // cap and kill, same protection execFile's old `maxBuffer` gave us for free.
    const overLimit = () => stdout.length + stderr.length > MAX_OUTPUT_BYTES;

    child.stdout.on("data", (d: Buffer) => {
      let s = d.toString();
      if (!pidLineConsumed) {
        const nl = s.indexOf("\n");
        if (s.startsWith(PID_MARKER) && nl !== -1) {
          containerPid = s.slice(PID_MARKER.length, nl).trim();
          s = s.slice(nl + 1);
          pidLineConsumed = true;
          if (signal?.aborted) onAbort(); // aborted in the gap before we had a pid to kill
        }
      }
      stdout += s;
      if (overLimit()) onAbort();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (overLimit()) onAbort();
    });
    child.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr: stderr || String(e), code: 1, timedOut });
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: killed ? (code ?? 143) : (code ?? 0), timedOut });
    });
  });
}

/** Park a session: stop the container but KEEP it (installs survive). */
export async function stopContainer(name: string): Promise<void> {
  try {
    await pexec("docker", ["stop", name]);
  } catch {
    /* not running */
  }
}

/** Destroy a session's container for good. */
export async function removeContainer(name: string): Promise<void> {
  try {
    await pexec("docker", ["rm", "-f", name]);
  } catch {
    /* already gone */
  }
}

async function listByLabel(sessionLabel: string, projectLabel: string): Promise<{ name: string; id: string; project: string }[]> {
  try {
    const { stdout } = await pexec("docker", [
      "ps",
      "--filter",
      `label=${sessionLabel}`,
      "--format",
      `{{.Names}}\t{{.Label "${sessionLabel}"}}\t{{.Label "${projectLabel}"}}`,
    ]);
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [name, id, project] = l.split("\t");
        return { name, id, project };
      });
  } catch {
    return [];
  }
}

/** Live source of truth: which Scuttle containers are actually running. Checks both the
 * current label scheme and the pre-rename "sponte.*" one, so containers created before
 * the Sponte → Scuttle rename don't just vanish from the session list — their labels
 * are baked in at creation time and can't be changed without recreating them. */
export async function listRunning(): Promise<{ name: string; id: string; project: string }[]> {
  const [current, legacy] = await Promise.all([
    listByLabel("scuttle.session", "scuttle.project"),
    listByLabel("sponte.session", "sponte.project"),
  ]);
  return [...current, ...legacy];
}
