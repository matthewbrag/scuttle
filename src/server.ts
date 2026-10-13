import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SERVER_PORT, MODEL_NAME, DEFAULT_GPU } from "./config";
import {
  createSession,
  listSessions,
  readMeta,
  readMessages,
  updateMeta,
  deleteSession,
  newId,
  repairDanglingToolCalls,
} from "./store";
import { textOf, type UploadedAttachment } from "./types";
import {
  containerName,
  ensureContainer,
  stopContainer,
  removeContainer,
  listRunning,
} from "./container";
import { submit, subscribe, isRunning, cancel, emitEvent } from "./runtime";
import { resolveProjectFile } from "./tools";
import { getContainerStats } from "./stats";
import { readCheckpoint as readCompactionCheckpoint, compact as compactSession } from "./compaction";
import { readAttachments } from "./attachments";
import { browseDir, makeDir } from "./browse";
import { requireAuth, login, logout, getOrCreatePassword, PASSWORD_PATH } from "./auth";
import { UPLOAD_MAX_BYTES } from "./config";
import type { AgentEvent } from "./events";

const app = express();
app.use(express.json());

// ---- Public: the SPA shell + login/logout. Everything below requireAuth is gated. ----
// Serving the app's own HTML/JS unauthenticated is normal (same as any login page) — the
// actual data lives behind the API routes further down, which DO require auth. Without
// this, there'd be nothing to load a login SCREEN from in the first place.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(__dirname, "..", "web", "dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
} else {
  app.get("/", (_req, res) => {
    res.status(503).send("Scuttle PWA not built yet — run `npm run build:web` in the scuttle repo, then restart the server.");
  });
}

app.post("/login", login);
app.post("/logout", logout);

app.use(requireAuth);

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: MODEL_NAME });
});

// Directory browsing for the "new session" project-picker dialog (see src/browse.ts).
app.get("/browse", (req, res) => {
  try {
    res.json(browseDir(req.query.path as string | undefined));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/browse/mkdir", (req, res) => {
  const { path: dir, name } = req.body ?? {};
  if (!dir || !name) return res.status(400).json({ error: "path and name required" });
  try {
    res.json({ path: makeDir(dir, name) });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// List sessions, reconciling stored metadata against Docker's live truth.
app.get("/sessions", async (_req, res) => {
  const running = new Set((await listRunning()).map((r) => r.id));
  res.json(
    listSessions().map((s) => ({
      ...s,
      status: running.has(s.id) ? "running" : "stopped",
      busy: isRunning(s.id),
    })),
  );
});

// Create a session and its durable container.
app.post("/sessions", async (req, res) => {
  const projectPath = req.body?.projectPath;
  if (!projectPath) return res.status(400).json({ error: "projectPath required" });
  const gpu = req.body?.gpu ?? DEFAULT_GPU;
  const id = newId();
  const meta = createSession(id, projectPath, MODEL_NAME, containerName(id), gpu);
  try {
    await ensureContainer(meta);
    res.json(meta);
  } catch (e: any) {
    deleteSession(id);
    res.status(500).json({ error: e.message });
  }
});

app.get("/sessions/:id/transcript", (req, res) => {
  if (!readMeta(req.params.id)) return res.status(404).json({ error: "not found" });
  res.json(readMessages(req.params.id));
});

// Serves a file from the session's project directory — read directly off the host
// filesystem (it's bind-mounted into the container, so no docker exec round-trip
// needed). Used by show_image so the PWA can render <img src="...">. resolveProjectFile
// (shared with the view_image/show_image tools) refuses anything that escapes the
// project root.
app.get("/sessions/:id/files/*", (req, res) => {
  const meta = readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: "not found" });
  const relPath = (req.params as any)[0] as string;
  const abs = resolveProjectFile(meta, relPath);
  if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: "no such file" });
  res.sendFile(abs);
});

// Saves an uploaded file into the session's project dir (under .scuttle-uploads/, so it
// sits beside the user's own files — the container already has it bind-mounted, no
// separate transfer needed once an agent turn wants to read it with its own tools).
// Raw body, not multipart: the browser just PUTs the file's bytes directly, filename
// in the query string — one file per request, which is all the upload dock needs.
app.post("/sessions/:id/upload", express.raw({ limit: UPLOAD_MAX_BYTES, type: () => true }), (req, res) => {
  const meta = readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: "not found" });
  const rawName = String(req.query.name || "upload.bin");
  const safeName = path.basename(rawName).replace(/[^\w.-]/g, "_") || "upload.bin";
  const dir = path.join(meta.projectPath, ".scuttle-uploads");
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now().toString(36)}-${safeName}`;
  const body = req.body as Buffer;
  fs.writeFileSync(path.join(dir, filename), body);
  const attachment: UploadedAttachment = {
    relPath: path.join(".scuttle-uploads", filename),
    mime: req.headers["content-type"] || "application/octet-stream",
    name: rawName,
    size: body.length,
  };
  res.json(attachment);
});

// Enqueue a user message. Returns immediately; work runs server-side.
app.post("/sessions/:id/input", (req, res) => {
  const text: string = req.body?.text ?? "";
  const attachments: UploadedAttachment[] = req.body?.attachments ?? [];
  if (!text.trim() && !attachments.length) return res.status(400).json({ error: "text or attachments required" });
  if (!readMeta(req.params.id)) return res.status(404).json({ error: "not found" });
  submit(req.params.id, { text, attachments });
  res.json({ ok: true });
});

// Subscribe to a session: replay transcript as events, then stream live ones.
app.get("/sessions/:id/stream", (req, res) => {
  const id = req.params.id;
  const meta = readMeta(id);
  if (!meta) return res.status(404).end();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const write = (e: AgentEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  // Reconstructed from the sidecar, not the persisted message content — that content
  // mixes the typed caption with whatever got inlined for the MODEL (a full text-file
  // dump, or a base64 image body), not what a human should see re-shown in the chat
  // bubble. Mirrors exactly what runtime.ts's live "user" event already showed.
  const attachmentRecords = readAttachments(id);
  let userSeq = 0;
  for (const m of readMessages(id)) {
    if (m.role === "user") {
      const records = attachmentRecords.filter((a) => a.userMessageSeq === userSeq);
      if (records.length) {
        const caption = Array.isArray(m.content) && m.content[0]?.type === "text" ? m.content[0].text.trim() : "";
        const fileNotes = records.filter((a) => !a.mime.startsWith("image/")).map((a) => `📎 ${a.name}`);
        write({ type: "user", content: [caption, ...fileNotes].filter(Boolean).join("\n") });
        for (const a of records.filter((a) => a.mime.startsWith("image/"))) {
          write({ type: "image", url: `/sessions/${id}/files/${a.relPath}`, caption: a.name });
        }
      } else {
        write({ type: "user", content: textOf(m.content) });
      }
      userSeq++;
    } else if (m.role === "assistant") {
      // Replayed as one-shot "deltas" (full text, not token-by-token) — fine for a
      // late-joining client catching up on history; only the live tail needs real streaming.
      if (m.reasoning_content) write({ type: "assistant_delta", reasoning: m.reasoning_content });
      if (m.content) write({ type: "assistant_delta", content: textOf(m.content) });
      for (const tc of m.tool_calls ?? []) {
        write({ type: "tool_call", name: tc.function.name, args: tc.function.arguments });
        // show_image's effect is a live event, not its own persisted message — reconstruct
        // it from the already-stored tool_call so a reconnecting client doesn't lose it.
        if (tc.function.name === "show_image") {
          try {
            const a = JSON.parse(tc.function.arguments);
            write({ type: "image", url: `/sessions/${id}/files/${a.path}`, caption: a.caption });
          } catch {
            /* malformed args — nothing to replay */
          }
        }
      }
    } else if (m.role === "tool") {
      write({ type: "tool_result", name: m.name ?? "", result: textOf(m.content) });
    }
  }
  // Current indicator state (not from transcript replay — it's mutable "what is it
  // right now", not an append-only log) and current running status.
  if (meta.indicators && Object.keys(meta.indicators).length) {
    write({ type: "indicators", indicators: meta.indicators });
  }
  const checkpoint = readCompactionCheckpoint(id);
  if (checkpoint) write({ type: "compacted", throughIndex: checkpoint.throughIndex });
  write({ type: "status", running: isRunning(id) });

  const off = subscribe(id, write);

  // Resource usage is a per-CONNECTION poll, not a session-wide event — it's a live
  // "right now" snapshot (cpu/mem/gpu), nothing to persist or replay on reconnect, and
  // polling only while someone's actually watching avoids running `docker stats` /
  // `nvidia-smi` for sessions nobody has open.
  const pollResources = () => getContainerStats(meta).then((s) => write({ type: "resources", ...s }));
  void pollResources();
  const interval = setInterval(pollResources, 3000);

  req.on("close", () => {
    off();
    clearInterval(interval);
  });
});

// Interrupt the in-flight turn only (Ctrl+C) — whatever's already queued still runs after.
app.post("/sessions/:id/cancel", (req, res) => {
  if (!readMeta(req.params.id)) return res.status(404).json({ error: "not found" });
  res.json({ ok: cancel(req.params.id) });
});

// Manual compaction — runs regardless of whether a turn is currently in flight; safe
// either way (see runtime.ts's emitEvent doc comment).
app.post("/sessions/:id/compact", async (req, res) => {
  const id = req.params.id;
  if (!readMeta(id)) return res.status(404).json({ error: "not found" });
  try {
    emitEvent(id, { type: "compacting" });
    const compacted = await compactSession(id, readMessages(id));
    if (compacted) {
      const cp = readCompactionCheckpoint(id);
      if (cp) emitEvent(id, { type: "compacted", throughIndex: cp.throughIndex });
    }
    res.json({ ok: true, compacted });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Park a session (stop container, keep it + all installs).
app.post("/sessions/:id/stop", async (req, res) => {
  const meta = readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: "not found" });
  await stopContainer(meta.container);
  updateMeta(meta.id, { status: "stopped" });
  res.json({ ok: true });
});

// Destroy a session (remove container + delete history).
app.delete("/sessions/:id", async (req, res) => {
  const meta = readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: "not found" });
  await removeContainer(meta.container);
  deleteSession(meta.id);
  res.json({ ok: true });
});

// SPA fallback for client-side routes — registered LAST so it never shadows an API
// route above; only reached once nothing earlier matched (which also means it only
// needs to exist at all when the build does).
if (fs.existsSync(webDist)) {
  app.get("*", (req, res, next) => {
    // An unmatched /sessions or /health path is a genuine 404, not a client-side route —
    // don't mask it behind the SPA shell (bit us once before, see sw.js's v1 bug note).
    if (req.path.startsWith("/sessions") || req.path === "/health" || req.path.startsWith("/browse")) return next();
    res.sendFile(path.join(webDist, "index.html"));
  });
}

const repaired = repairDanglingToolCalls();
if (repaired > 0) console.log(`  repaired ${repaired} session(s) interrupted by the last restart`);

app.listen(SERVER_PORT, "127.0.0.1", () => {
  console.log(`scuttle server → http://127.0.0.1:${SERVER_PORT}  (model: ${MODEL_NAME})`);
  console.log(`  auth: scuttle / ${getOrCreatePassword()}  (stored at ${PASSWORD_PATH})`);
});
