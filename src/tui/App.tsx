import React, { useState, useEffect, useRef, useCallback } from "react";
import { useApp, useInput, useStdout } from "ink";
import { Layout } from "./components/Layout";
import { applyEvent, type Block } from "./logic";
import * as api from "./api";
import type { AgentEvent } from "../events";
import { SPINNER_INTERVAL_MS } from "./theme";
import { scrollUp as scrollUpPure, scrollDown as scrollDownPure } from "./scroll";
import type { Indicator, Stats, ResourceStats } from "./components/Sidebar";
import { matchCommands } from "../commands";

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [label, setLabel] = useState("new session — type to begin");
  const [model, setModel] = useState("connecting…");
  const [lastList, setLastList] = useState<any[]>([]);
  const [frame, setFrame] = useState(0);
  // null = pinned to the latest (auto-follow); a number = frozen scrollback position
  // (an absolute index into `blocks`, so it stays put as new blocks get appended —
  // not "N blocks back", which would silently drift as the array grows).
  const [viewEnd, setViewEnd] = useState<number | null>(null);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [stats, setStats] = useState<Stats>({});
  const [resources, setResources] = useState<ResourceStats>({});
  const abortRef = useRef<AbortController | null>(null);

  // Single shared animation tick, only while something is actually running — avoids
  // burning CPU/re-rendering when idle. Layout threads `frame` only to the status dot
  // and the one currently-running tool card, so memoized history never re-renders.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setFrame((f) => f + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    const on = () => setSize({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", on);
    return () => void stdout.off("resize", on);
  }, [stdout]);

  useEffect(() => {
    api.health().then((h: any) => setModel(h.model)).catch(() => setModel("server down"));
  }, []);

  // `attach` is idempotent per-id and returns a promise that resolves once the SSE
  // connection is confirmed open server-side (not just requested) — see api.ts's
  // streamSession `onOpen` doc comment for why that distinction is the whole fix here.
  // Both the reactive effect below (switching sessions via /open) and submit() (a
  // brand-new session's first message) call this SAME function; whichever runs first
  // does the connecting, the other just gets the same in-flight/completed promise —
  // so a new session is never sent input before its stream is guaranteed listening.
  const attachRef = useRef<{ id: string; promise: Promise<void> } | null>(null);
  const attach = useCallback((id: string): Promise<void> => {
    if (attachRef.current?.id === id) return attachRef.current.promise;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBlocks([]);
    setIndicators([]); // fresh session = fresh indicators; the server replays current ones if any
    setStats({});
    setResources({});
    const p = new Promise<void>((resolve) => {
      // onOpen (the real signal) resolves this as soon as the connection is confirmed.
      // The .then/.catch below is a safety net: if streamSession fails or gets aborted
      // before ever reaching onOpen, this still resolves instead of leaving `attach()`
      // callers (submit() awaits this) hanging forever on a promise nothing settles.
      void api
        .streamSession(
          id,
          ac.signal,
          (e: AgentEvent) => {
            if (e.type === "status") setRunning(e.running);
            else if (e.type === "idle") setRunning(false);
            else if (e.type === "done") void 0;
            else if (e.type === "indicators") {
              setIndicators(Object.entries(e.indicators).map(([name, v]) => ({ name, ...v })));
            } else if (e.type === "model_stats") {
              setStats({ ctxUsed: e.promptTokens, ctxMax: e.ctxMax, tokPerSec: e.tokPerSec, specAccept: e.specAccept, elapsedMs: e.elapsedMs, turn: e.step, cachedTokens: e.cachedTokens });
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
        )
        .then(resolve, resolve);
    });
    attachRef.current = { id, promise: p };
    return p;
  }, []);

  useEffect(() => {
    if (current) void attach(current);
  }, [current, attach]);

  const submit = useCallback(
    async (text: string) => {
      try {
        let id = current;
        if (!id) {
          const s = await api.createSession(process.cwd());
          id = s.id;
          setLabel(s.summary || "session");
          setCurrent(id);
          await attach(id!); // guaranteed live before we send anything — fixes the race
        }
        setBlocks((b) => applyEvent(b, { type: "user", content: text }, { optimistic: true }));
        setRunning(true);
        await api.sendInput(id!, text);
      } catch (e: any) {
        setBlocks((b) => [...b, { kind: "error", text: e.message }]);
      }
    },
    [current, attach],
  );

  const handleCommand = useCallback(
    async (t: string) => {
      const [cmd, arg] = t.slice(1).split(/\s+/, 2);
      try {
        if (cmd === "exit" || cmd === "quit") exit();
        else if (cmd === "new") {
          abortRef.current?.abort();
          attachRef.current = null;
          setCurrent(null);
          setBlocks([]);
          setIndicators([]);
          setStats({});
          setResources({});
          setRunning(false);
          setViewEnd(null);
          setLabel("new session — type to begin");
        } else if (cmd === "sessions" || cmd === "ls") {
          const list = await api.listSessions();
          setLastList(list);
          const text =
            "sessions:\n" +
            list.map((s: any, i: number) => `  [${i}] ${s.summary || "(new)"}  ${s.projectPath}`).join("\n") +
            "\n(use /open <n>)";
          setBlocks((b) => [...b, { kind: "info", text }]);
        } else if (cmd === "open") {
          const s = /^\d+$/.test(arg || "") ? lastList[Number(arg)] : lastList.find((x: any) => x.id === arg);
          if (s) {
            setLabel(s.summary || "session");
            setCurrent(s.id);
            setViewEnd(null);
          } else setBlocks((b) => [...b, { kind: "error", text: "usage: /open <index from /sessions>" }]);
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
            if (id === current) {
              setCurrent(null);
              setBlocks([]);
            }
          }
        } else {
          setBlocks((b) => [...b, { kind: "error", text: `unknown command: /${cmd}` }]);
        }
      } catch (e: any) {
        setBlocks((b) => [...b, { kind: "error", text: e.message }]);
      }
    },
    [current, lastList, exit],
  );

  const SCROLL_STEP = 1;
  const SCROLL_PAGE = 10;
  const scrollUp = useCallback((by: number) => setViewEnd((v) => scrollUpPure(v, blocks.length, by)), [blocks.length]);
  const scrollDown = useCallback((by: number) => setViewEnd((v) => scrollDownPure(v, blocks.length, by)), [blocks.length]);

  // Still composing the command name itself (no space yet) → the popup is showing and
  // claims up/down/tab/enter; past the first space, those return to their normal jobs
  // (scroll, expand, submit) so typing a command's arguments feels like normal typing.
  const menuMatches = input.startsWith("/") && !input.includes(" ") ? matchCommands(input) : [];
  useEffect(() => setCmdIndex(0), [input]);

  useInput((ch, key) => {
    // Ctrl+C: cancel the in-flight turn if one is running (never silently discarded —
    // the backend only ever drops the CURRENT turn, anything already queued still runs
    // after, exactly like a normal completion). Only exits the app when idle, matching
    // normal shell/REPL expectations. This requires exitOnCtrlC:false in index.tsx —
    // otherwise Ink intercepts Ctrl+C before useInput ever sees it.
    if (key.ctrl && ch === "c") {
      if (running && current) void api.cancelSession(current).catch(() => {});
      else exit();
      return;
    }

    if (menuMatches.length > 0) {
      if (key.upArrow) {
        setCmdIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setCmdIndex((i) => Math.min(menuMatches.length - 1, i + 1));
        return;
      }
      if (key.tab || key.return) {
        const chosen = menuMatches[Math.min(cmdIndex, menuMatches.length - 1)];
        if (chosen.hint) {
          setInput(`/${chosen.name} `); // needs args — drop into the input, ready to type them
        } else {
          setInput("");
          void handleCommand(`/${chosen.name}`); // no args needed — just run it
        }
        return;
      }
      // anything else (typing more, backspace) falls through to normal editing below,
      // which naturally re-filters the popup via the derived `menuMatches` above.
    }

    if (key.tab) {
      setExpanded((x) => !x);
      return;
    }
    if (key.upArrow) return scrollUp(SCROLL_STEP);
    if (key.downArrow) return scrollDown(SCROLL_STEP);
    if (key.pageUp) return scrollUp(SCROLL_PAGE);
    if (key.pageDown) return scrollDown(SCROLL_PAGE);
    if (key.return) {
      const t = input.trim();
      setInput("");
      if (!t) return;
      setViewEnd(null); // sending always snaps back to the live view
      if (t.startsWith("/")) void handleCommand(t);
      else void submit(t);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || key.escape) return;
    if (ch) setInput((s) => s + ch);
  });

  const visibleBlocks = viewEnd == null ? blocks : blocks.slice(0, viewEnd);

  return (
    <Layout
      size={size}
      label={label}
      model={model}
      running={running}
      frame={frame}
      blocks={visibleBlocks}
      scrolled={viewEnd != null}
      expanded={expanded}
      input={input}
      cmdIndex={cmdIndex}
      indicators={indicators}
      stats={stats}
      resources={resources}
    />
  );
}
