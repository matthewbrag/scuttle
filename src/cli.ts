import readline from "node:readline";
import path from "node:path";
import { SERVER_PORT } from "./config";
import { getOrCreatePassword, AUTH_USERNAME } from "./auth";
import type { AgentEvent } from "./events";

// Thin client. All state + the agent loop live in the server; the CLI subscribes.
const BASE = process.env.SCUTTLE_SERVER || `http://127.0.0.1:${SERVER_PORT}`;
const AUTH = "Basic " + Buffer.from(`${AUTH_USERNAME}:${getOrCreatePassword()}`).toString("base64");

async function api(method: string, p: string, body?: any) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Authorization: AUTH, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

async function ensureServer() {
  try {
    await api("GET", "/health");
  } catch {
    console.error(
      "scuttle: server not reachable at " +
        BASE +
        "\n  start it with:  npm run server   (or install the systemd --user service)",
    );
    process.exit(1);
  }
}

// Tracks which kind of streamed text is currently mid-line, so consecutive deltas of
// the same kind print flush (true streaming) while a kind change (or a new turn / tool
// call) starts a fresh labeled line — mirrors the merge rule in tui/logic.ts.
let streamKind: "reasoning" | "content" | null = null;

function render(e: AgentEvent) {
  switch (e.type) {
    case "user":
      streamKind = null;
      process.stdout.write(`\n\x1b[35m› \x1b[0m${e.content}\n`);
      break;
    case "assistant_delta":
      if (e.reasoning) {
        if (streamKind !== "reasoning") process.stdout.write(`\n\x1b[90m◇ thinking  `);
        process.stdout.write(`\x1b[90m${e.reasoning}\x1b[0m`);
        streamKind = "reasoning";
      }
      if (e.content) {
        if (streamKind !== "content") process.stdout.write(`\n\x1b[36m`);
        process.stdout.write(`\x1b[36m${e.content}\x1b[0m`);
        streamKind = "content";
      }
      break;
    case "tool_call":
      streamKind = null;
      process.stdout.write(`\n\x1b[33m▸ ${e.name}(${e.args})\x1b[0m\n`);
      break;
    case "tool_result":
      process.stdout.write(`\x1b[90m${e.result.split("\n").slice(0, 20).join("\n")}\x1b[0m\n`);
      break;
    case "status":
      if (e.running) process.stdout.write(`\x1b[90m[running…]\x1b[0m\n`);
      break;
    case "compacting":
      streamKind = null;
      process.stdout.write(`\x1b[90m🗜 compacting older messages…\x1b[0m\n`);
      break;
    case "compacted":
      streamKind = null;
      process.stdout.write(`\x1b[90m🗜 compacted ${e.throughIndex} earlier messages\x1b[0m\n`);
      break;
    case "retry":
      streamKind = null;
      process.stdout.write(`\x1b[90m🔁 ${e.reason}\x1b[0m\n`);
      break;
    case "error":
      streamKind = null;
      process.stdout.write(`\x1b[31m✖ ${e.message}\x1b[0m\n`);
      break;
  }
}

// ---- one-shot subcommands ---------------------------------------------------

async function listCmd() {
  const list: any[] = await api("GET", "/sessions");
  if (!list.length) return console.log("(no sessions)");
  for (const s of list) {
    const dot = s.busy ? "\x1b[33m◐\x1b[0m" : s.status === "running" ? "\x1b[32m●\x1b[0m" : "○";
    const when = new Date(s.updatedAt).toLocaleString();
    const label = s.summary || "(new)";
    console.log(`${dot} ${s.id}  ${label.padEnd(28)}  ${when}  ${s.projectPath}`);
  }
}

// ---- interactive mode -------------------------------------------------------

let sub: AbortController | null = null;

function attach(id: string) {
  sub?.abort();
  const ac = new AbortController();
  sub = ac;
  (async () => {
    const res = await fetch(`${BASE}/sessions/${id}/stream`, { signal: ac.signal, headers: { Authorization: AUTH } });
    if (!res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const p of parts) {
        const line = p.replace(/^data: /, "").trim();
        if (line) render(JSON.parse(line) as AgentEvent);
      }
    }
  })().catch(() => {});
}

async function interactive() {
  await ensureServer();
  const cwd = process.cwd();
  let current: string | null = null;
  let lastList: any[] = [];

  console.log("scuttle — type a message to start a session in this folder. /help for commands.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\nscuttle› " });
  rl.prompt();

  rl.on("line", async (line) => {
    const t = line.trim();
    try {
      if (!t) {
        // fall through to reprompt
      } else if (t.startsWith("/")) {
        const [cmd, arg] = t.slice(1).split(/\s+/, 2);
        if (cmd === "help") {
          console.log(
            "/sessions  list & pick   /open <n|id>  attach   /new  fresh session\n/stop  park   /compact  summarize now   /rm <id>  delete   /exit",
          );
        } else if (cmd === "sessions" || cmd === "ls") {
          lastList = await api("GET", "/sessions");
          if (!lastList.length) console.log("(no sessions)");
          lastList.forEach((s, i) => {
            const mark = s.id === current ? "*" : " ";
            console.log(`${mark}[${i}] ${s.id}  ${(s.summary || "(new)").padEnd(24)}  ${s.projectPath}`);
          });
        } else if (cmd === "open") {
          const s = /^\d+$/.test(arg || "") ? lastList[Number(arg)] : lastList.find((x) => x.id === arg);
          if (!s) console.log("usage: /open <index-from-/sessions | id>");
          else {
            current = s.id;
            console.log(`\x1b[90m[attached ${s.id} — ${s.summary || "new"}]\x1b[0m`);
            attach(current!);
          }
        } else if (cmd === "new") {
          sub?.abort();
          current = null;
          console.log("\x1b[90m[next message starts a new session]\x1b[0m");
        } else if (cmd === "stop") {
          if (current) {
            await api("POST", `/sessions/${current}/stop`);
            console.log("\x1b[90m[parked]\x1b[0m");
          }
        } else if (cmd === "compact") {
          if (!current) console.log("no active session");
          else {
            const r = await api("POST", `/sessions/${current}/compact`);
            if (!r.compacted) console.log("\x1b[90m[nothing to compact yet]\x1b[0m");
          }
        } else if (cmd === "rm") {
          const id = arg || current;
          if (id) {
            await api("DELETE", `/sessions/${id}`);
            if (id === current) current = null;
            console.log("\x1b[90m[deleted " + id + "]\x1b[0m");
          }
        } else if (cmd === "exit" || cmd === "quit") {
          rl.close();
          return;
        } else {
          console.log("unknown command; /help");
        }
      } else {
        // a message: create a session on first use, then submit
        if (!current) {
          const s = await api("POST", "/sessions", { projectPath: cwd });
          current = s.id;
          console.log(`\x1b[90m[new session ${s.id}]\x1b[0m`);
          attach(current!);
        }
        await api("POST", `/sessions/${current}/input`, { text: t });
      }
    } catch (e: any) {
      console.error(`\x1b[31m${e.message}\x1b[0m`);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    sub?.abort();
    process.exit(0);
  });
}

// ---- entry ------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const plain = argv.includes("--plain");
  const [cmd, ...rest] = argv.filter((a) => a !== "--plain");
  if (!cmd) {
    await ensureServer();
    if (plain) return interactive();
    return (await import("./tui/index")).start();
  }
  await ensureServer();
  switch (cmd) {
    case "ls":
    case "list":
      return listCmd();
    case "stop":
      await api("POST", `/sessions/${rest[0]}/stop`);
      return console.log("parked", rest[0]);
    case "rm":
      await api("DELETE", `/sessions/${rest[0]}`);
      return console.log("deleted", rest[0]);
    default:
      console.log("usage: scuttle [ls | stop <id> | rm <id>]   (no args = interactive)");
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
