import React, { useState, useEffect, useRef, useCallback } from "react";
import { applyEvent, type Block } from "../../src/tui/logic";
import * as api from "./api";
import type { AgentEvent } from "../../src/events";
import { SessionList } from "./components/SessionList";
import { Chat } from "./components/Chat";
import { InputBar } from "./components/InputBar";
import { Sidebar, type Stats, type ResourceStats } from "./components/Sidebar";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { LoginScreen } from "./components/LoginScreen";

export interface SessionSummary {
  id: string;
  summary: string;
  projectPath: string;
  status: "running" | "stopped";
  busy: boolean;
  updatedAt: string;
}

export interface Indicator {
  name: string;
  value: string;
  goal?: string;
  trend?: "up" | "down";
}

export function App() {
  // null = still checking; false = show the login screen; true = normal app.
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("connecting…");
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [stats, setStats] = useState<Stats>({});
  const [resources, setResources] = useState<ResourceStats>({});
  // Mobile (narrow viewport) is single-pane: list OR chat, never both.
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);

  // 100dvh alone isn't reliable once the on-screen keyboard opens — some mobile browsers
  // (notably Android Chrome) resize the VISUAL viewport without correctly shrinking what
  // dvh is computed from, so the input bar ends up laid out under the keyboard instead of
  // above it. visualViewport.height tracks the keyboard reliably where it's supported;
  // --vvh falls back to 100dvh (see app.css) on browsers without it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  const unsubRef = useRef<(() => void) | null>(null);
  const attachRef = useRef<{ id: string; promise: Promise<void> } | null>(null);
  // The message typed before a project folder was picked — sent once the dialog confirms.
  const pendingMessageRef = useRef<{ text: string; files: File[] } | null>(null);

  const refreshSessions = useCallback(() => {
    api.listSessions().then(setSessions).catch(() => {});
  }, []);

  // Runs once on load, independent of everything else below — those all need a real
  // session and would otherwise just 401 repeatedly against a cookie that isn't there yet.
  useEffect(() => {
    api
      .health()
      .then(() => setAuthed(true))
      .catch((e: any) => setAuthed(String(e.message).startsWith("401") ? false : true));
  }, []);

  useEffect(() => {
    if (!authed) return;
    api.health().then((h: any) => setModel(h.model)).catch(() => setModel("server down"));
    refreshSessions();
    const id = setInterval(refreshSessions, 4000); // cheap poll for the list — new/other clients' sessions
    return () => clearInterval(id);
  }, [authed, refreshSessions]);

  // Same idempotent-per-id + onOpen-confirms-the-race-is-closed pattern as the TUI
  // (tui/App.tsx) — a fast local-model turn can otherwise finish and broadcast its
  // events to zero listeners before the SSE connection is actually confirmed open.
  const attach = useCallback((id: string): Promise<void> => {
    if (attachRef.current?.id === id) return attachRef.current.promise;
    unsubRef.current?.();
    setBlocks([]);
    setIndicators([]); // fresh session = fresh indicators; the server replays current ones if any
    setStats({});
    setResources({});
    const p = new Promise<void>((resolve) => {
      const unsub = api.streamSession(
        id,
        (e: AgentEvent) => {
          if (e.type === "status") setRunning(e.running);
          else if (e.type === "idle") {
            setRunning(false);
            refreshSessions();
          } else if (e.type === "done") void 0;
          else if (e.type === "indicators") {
            setIndicators(Object.entries(e.indicators).map(([name, v]) => ({ name, ...v })));
          } else if (e.type === "model_stats") {
            setStats({ ctxUsed: e.promptTokens, ctxMax: e.ctxMax, tokPerSec: e.tokPerSec, specAccept: e.specAccept });
          } else if (e.type === "resources") {
            setResources({
              cpuPercent: e.cpuPercent,
              memUsedMB: e.memUsedMB,
              memLimitMB: e.memLimitMB,
              gpuUtilPercent: e.gpuUtilPercent,
              gpuMemUsedMB: e.gpuMemUsedMB,
              gpuMemTotalMB: e.gpuMemTotalMB,
            });
          } else setBlocks((b) => applyEvent(b, e));
        },
        resolve,
      );
      unsubRef.current = unsub;
    });
    attachRef.current = { id, promise: p };
    return p;
  }, [refreshSessions]);

  useEffect(() => {
    if (current) void attach(current);
    return () => unsubRef.current?.();
  }, [current, attach]);

  const openSession = useCallback((id: string, s?: SessionSummary) => {
    setCurrent(id);
    setMobileView("chat");
    void s;
  }, []);

  const newSession = useCallback(() => {
    unsubRef.current?.();
    attachRef.current = null;
    setCurrent(null);
    setBlocks([]);
    setIndicators([]);
    setStats({});
    setResources({});
    setRunning(false);
    setMobileView("chat");
  }, []);

  const sendToSession = useCallback(async (id: string, text: string, files: File[]) => {
    try {
      const attachments = files.length ? await Promise.all(files.map((f) => api.uploadFile(id, f))) : [];
      // Images arrive as their own inline block via the live SSE "image" event, which
      // lands moments later (agent.ts emits it before the model call even starts) — no
      // optimistic preview needed. Mirrors runtime.ts's server-side display exactly, so
      // the ghost-message confirm-match (exact text equality) still finds this block.
      const fileNotes = attachments.filter((a) => !a.mime.startsWith("image/")).map((a) => `📎 ${a.name}`);
      const display = [text.trim(), ...fileNotes].filter(Boolean).join("\n");
      setBlocks((b) => applyEvent(b, { type: "user", content: display }, { optimistic: true }));
      setRunning(true);
      await api.sendInput(id, text, attachments);
    } catch (e: any) {
      setBlocks((b) => [...b, { kind: "error", text: e.message }]);
    }
  }, []);

  const submit = useCallback(
    async (text: string, files: File[] = []) => {
      if (!current) {
        // No session yet — stash the message and ask where it should live; sent once
        // the dialog confirms a folder (see createSessionAt below).
        pendingMessageRef.current = { text, files };
        setNewSessionDialogOpen(true);
        return;
      }
      await sendToSession(current, text, files);
    },
    [current, sendToSession],
  );

  const createSessionAt = useCallback(
    async (projectPath: string) => {
      // Only session creation itself can fail the dialog (bad path, etc.) — once it
      // succeeds we're committed: close the dialog and switch views immediately so
      // there's instant feedback, rather than waiting on attach()/the pending send too
      // (same as openSession, which doesn't block navigation on attach() either).
      const s = await api.createSession(projectPath);
      setCurrent(s.id);
      setMobileView("chat");
      setNewSessionDialogOpen(false);
      attach(s.id)
        .then(() => {
          const pending = pendingMessageRef.current;
          pendingMessageRef.current = null;
          if (pending) return sendToSession(s.id, pending.text, pending.files);
        })
        .catch((e: any) => setBlocks((b) => [...b, { kind: "error", text: e.message }]));
    },
    [attach, sendToSession],
  );

  const cancel = useCallback(() => {
    if (current) void api.cancelSession(current).catch(() => {});
  }, [current]);

  // Mirrors tui/App.tsx's handleCommand — same command set (src/commands.ts), adapted
  // for a browser: "exit" has nothing to quit, so it just backs out to the list pane.
  const handleCommand = useCallback(
    async (t: string) => {
      const [cmd, arg] = t.slice(1).split(/\s+/, 2);
      try {
        if (cmd === "exit" || cmd === "quit") setMobileView("list");
        else if (cmd === "new") newSession();
        else if (cmd === "sessions" || cmd === "ls") refreshSessions();
        else if (cmd === "open") {
          const s = /^\d+$/.test(arg || "") ? sessions[Number(arg)] : sessions.find((x) => x.id === arg);
          if (s) openSession(s.id, s);
          else setBlocks((b) => [...b, { kind: "error", text: "usage: /open <index|id> — see the session list" }]);
        } else if (cmd === "stop") {
          if (current) await api.stopSession(current);
        } else if (cmd === "compact") {
          if (current) {
            const r = await api.compactSession(current);
            if (!r.compacted) setBlocks((b) => [...b, { kind: "info", text: "nothing to compact yet" }]);
          } else setBlocks((b) => [...b, { kind: "error", text: "no active session" }]);
        } else if (cmd === "rm") {
          const id = arg || current;
          if (id) {
            await api.rmSession(id);
            refreshSessions();
            if (id === current) newSession();
          }
        } else {
          setBlocks((b) => [...b, { kind: "error", text: `unknown command: /${cmd}` }]);
        }
      } catch (e: any) {
        setBlocks((b) => [...b, { kind: "error", text: e.message }]);
      }
    },
    [current, sessions, newSession, openSession, refreshSessions],
  );

  const currentMeta = sessions.find((s) => s.id === current);

  if (authed === null) return <div className="boot-screen">loading…</div>;
  if (authed === false) return <LoginScreen onSuccess={() => setAuthed(true)} />;

  return (
    <div className="app">
      <SessionList
        sessions={sessions}
        currentId={current}
        onOpen={openSession}
        onNew={newSession}
        visible={mobileView === "list"}
      />
      <div className={`chat-pane ${mobileView === "chat" ? "visible" : ""}`}>
        <header className="chat-header">
          <button className="back-btn" onClick={() => setMobileView("list")} aria-label="Back to sessions">
            ←
          </button>
          <div className="chat-title">
            <span className="brand">✦ scuttle</span>
            <span className="dim"> › </span>
            <span className="dim2">{currentMeta?.summary || (current ? "session" : "new session")}</span>
          </div>
          <div className="chat-status">
            <span className={running ? "dot running" : "dot idle"}>{running ? "●" : "○"}</span>
            <span className="dim2">{running ? "running" : "idle"} · {model}</span>
          </div>
        </header>
        <Chat blocks={blocks} />
        <InputBar
          input={input}
          setInput={setInput}
          onSubmit={submit}
          onCommand={handleCommand}
          running={running}
          onCancel={cancel}
        />
      </div>
      <Sidebar stats={stats} resources={resources} indicators={indicators} />
      <NewSessionDialog
        open={newSessionDialogOpen}
        onCancel={() => {
          pendingMessageRef.current = null;
          setNewSessionDialogOpen(false);
        }}
        onConfirm={createSessionAt}
      />
    </div>
  );
}
