import fs from "node:fs";
import path from "node:path";
import type { ToolSchema } from "./model";
import type { SessionMeta, ContentPart } from "./types";
import { execInContainer } from "./container";
import { startBackground, checkBackground, killBackground, listTasks } from "./background";
import { readMeta, updateMeta } from "./store";
import type { AgentEvent } from "./events";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // generous for a chart/screenshot; a full photo
// dump should be resized first — the agent already has run_bash + PIL in-container for that.

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Resolves a path relative to the project dir, refusing anything that escapes it
 * (shared by view_image, show_image, and server.ts's file-serving endpoint). */
export function resolveProjectFile(meta: SessionMeta, relPath: string): string | null {
  const abs = path.resolve(meta.projectPath, relPath);
  const root = path.resolve(meta.projectPath) + path.sep;
  if (!abs.startsWith(root)) return null;
  return abs;
}

export const tools: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "run_bash",
      description:
        "Run a bash command inside the session's sandbox container, in the project directory. " +
        "Returns the exit code and combined stdout/stderr. For anything long-running (a training " +
        "run, a dev server, a big download) set background:true instead of waiting — it starts the " +
        "command and returns immediately with a task_id, so you can keep working and check on it " +
        "later with check_background.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to run." },
          background: {
            type: "boolean",
            description: "Run detached and return immediately with a task_id instead of waiting for it to finish.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_background",
      description: "Check a background task's output so far and whether it's still running.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string", description: "The task_id returned by run_bash background:true." } },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_background",
      description: "Stop a background task early.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string", description: "The task_id to stop." } },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_background",
      description: "List background tasks started in this session.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "view_image",
      description:
        "Load an image file from the project (png/jpg/jpeg/gif/webp) so YOU can see it — e.g. a chart you " +
        "just generated, a screenshot, a diagram. Use this to check your own visual output before describing it.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path to the image, relative to the project root." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_image",
      description: "Display an image to the USER in their chat UI (the PWA renders it inline; the terminal shows a link).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the image, relative to the project root." },
          caption: { type: "string", description: "Optional short caption." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_metric",
      description:
        "Report a live value for something you're tracking across this session — e.g. training loss, " +
        "throughput, accuracy. Shows up in an INDICATORS panel the human can watch (desktop/TUI only — " +
        "there usually isn't room on a phone screen, so don't rely on it being seen immediately there). " +
        "Call this again with the same name to update it; values persist until clear_metric or the session ends.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short label, e.g. 'train loss'." },
          value: { type: "string", description: "Current value, e.g. '0.17'." },
          goal: { type: "string", description: "Optional target to show alongside it, e.g. '0.05'." },
          trend: { type: "string", enum: ["up", "down"], description: "Optional direction arrow." },
        },
        required: ["name", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_metric",
      description: "Remove an indicator you're no longer tracking.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The indicator name to remove." } },
        required: ["name"],
      },
    },
  },
];

export async function executeTool(
  session: SessionMeta,
  name: string,
  args: any,
  signal?: AbortSignal,
  emit?: (e: AgentEvent) => void,
): Promise<string | ContentPart[]> {
  if (name === "run_bash") {
    const command = String(args?.command ?? "");
    if (args?.background) {
      try {
        const task = await startBackground(session, command);
        return `started background task ${task.id} (pid ${task.pid}). Use check_background with this task_id to see output.`;
      } catch (e: any) {
        return `error starting background task: ${e.message}`;
      }
    }
    const { stdout, stderr, code } = await execInContainer(session.container, command, signal);
    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    return `exit ${code}\n${out || "(no output)"}`.slice(0, 20000);
  }
  if (name === "check_background") {
    const r = await checkBackground(session, String(args?.task_id ?? ""));
    if (!r) return "error: no such task_id";
    return `${r.running ? "still running" : "finished"}\n${r.output}`.slice(0, 20000);
  }
  if (name === "kill_background") {
    const ok = await killBackground(session, String(args?.task_id ?? ""));
    return ok ? "killed" : "error: no such task_id";
  }
  if (name === "list_background") {
    const tasks = listTasks(session.id);
    if (!tasks.length) return "no background tasks in this session";
    return tasks.map((t) => `${t.id}  pid ${t.pid}  started ${t.startedAt}  ${t.command}`).join("\n");
  }
  if (name === "view_image") {
    const relPath = String(args?.path ?? "");
    const abs = resolveProjectFile(session, relPath);
    if (!abs) return "error: path escapes the project directory";
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) return `error: unsupported image type '${ext}' (supported: ${Object.keys(MIME_BY_EXT).join(", ")})`;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return `error: no such file: ${relPath}`;
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      return `error: ${relPath} is ${(stat.size / 1e6).toFixed(1)}MB, over the ${MAX_IMAGE_BYTES / 1e6}MB limit — resize it first (you have PIL in the container).`;
    }
    const b64 = fs.readFileSync(abs).toString("base64");
    return [
      { type: "text", text: `image: ${relPath}` },
      { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
    ];
  }
  if (name === "show_image") {
    const relPath = String(args?.path ?? "");
    const abs = resolveProjectFile(session, relPath);
    if (!abs) return "error: path escapes the project directory";
    if (!fs.existsSync(abs)) return `error: no such file: ${relPath}`;
    emit?.({ type: "image", url: `/sessions/${session.id}/files/${relPath}`, caption: args?.caption });
    return `shown to the user: ${relPath}`;
  }
  if (name === "set_metric") {
    const metricName = String(args?.name ?? "");
    if (!metricName) return "error: name is required";
    // Re-read current meta (not the `session` snapshot passed into this call) so two
    // metrics set back-to-back in the same turn don't clobber each other.
    const fresh = readMeta(session.id);
    if (!fresh) return "error: session not found";
    const indicators = { ...fresh.indicators, [metricName]: { value: String(args?.value ?? ""), goal: args?.goal, trend: args?.trend } };
    updateMeta(session.id, { indicators });
    emit?.({ type: "indicators", indicators });
    return `set ${metricName} = ${args?.value}`;
  }
  if (name === "clear_metric") {
    const metricName = String(args?.name ?? "");
    const fresh = readMeta(session.id);
    if (!fresh) return "error: session not found";
    const indicators = { ...fresh.indicators };
    delete indicators[metricName];
    updateMeta(session.id, { indicators });
    emit?.({ type: "indicators", indicators });
    return `cleared ${metricName}`;
  }
  return `error: unknown tool ${name}`;
}
