import type { AgentEvent } from "../events";

// Pure, testable view-model logic: turning the event stream into renderable blocks.

export type Block =
  | { kind: "user"; text: string; pending?: boolean }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; args: string; result: string | null; running: boolean; startedAt: number }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string }
  | { kind: "image"; url: string; caption?: string };

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

const INLINE_RE = /\*\*(.+?)\*\*|`([^`]+?)`|\*(.+?)\*|_(.+?)_/g;

/** Tokenize `**bold**`, `` `code` ``, and `*italic*`/`_italic_` into styled spans for
 * rendering. An unterminated marker (no closing pair) safely falls through as plain
 * literal text. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) spans.push({ text: m[2], code: true });
    else if (m[3] !== undefined) spans.push({ text: m[3], italic: true });
    else if (m[4] !== undefined) spans.push({ text: m[4], italic: true });
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length ? spans : [{ text }];
}

/** Spans rejoined back to their literal rendered characters (markers stripped). */
export function spansToText(spans: Span[]): string {
  let out = "";
  for (const s of spans) out += s.text;
  return out;
}

/** The text as it actually renders — markdown markers stripped. This (NOT the raw
 * markdown-laden string) is what wrapCount/estimateLines must measure, or the windowing
 * estimate would overcount by the width of every `**`/backtick marker that disappears
 * at render time — the same estimate/render desync class of bug this session hit twice. */
export function plainText(text: string): string {
  return spansToText(parseInline(text));
}

export type MdBlock =
  | { kind: "code"; lang?: string; lines: string[] }
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "list"; ordered: boolean; items: Span[][] }
  | { kind: "para"; spans: Span[] };

const FENCE_RE = /^```\s*([\w+-]*)\s*$/;
const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const LIST_RE = /^(?:[-*]|\d+\.)\s+(.*)$/;
const ORDERED_RE = /^\d+\./;

/** Splits a message's text into block-level markdown elements — fenced code, headings,
 * lists, and plain paragraphs. Line-based and intentionally simple (no nested lists,
 * blockquotes, tables): coding-agent output is overwhelmingly these four shapes, and a
 * line unmatched by anything just falls into a paragraph, so nothing is ever lost, only
 * left unstyled. */
export function parseBlocks(text: string): MdBlock[] {
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ kind: "para", spans: parseInline(para.join("\n")) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", ordered: list.ordered, items: list.items.map(parseInline) });
    list = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      flushList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or just EOF if the model never closed it)
      blocks.push({ kind: "code", lang: fence[1] || undefined, lines: body });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ kind: "heading", level: heading[1].length, spans: parseInline(heading[2]) });
      i++;
      continue;
    }
    const listMatch = LIST_RE.exec(line);
    if (listMatch) {
      flushPara();
      const ordered = ORDERED_RE.test(line);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(listMatch[1]);
      i++;
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      i++;
      continue;
    }
    flushList();
    para.push(line);
    i++;
  }
  flushPara();
  flushList();
  return blocks.length ? blocks : [{ kind: "para", spans: [] }];
}

/** How many rows `parseBlocks(text)` renders to at `width` — mirrors MessageBlock's
 * actual layout for every block kind (see estimateLines' doc comment on why this has to
 * stay in lockstep with the renderer). List items get a 2-col bullet indent; code blocks
 * get a bordered card like a tool result, hence CARD_PAD. */
export function estimateMarkdownLines(text: string, width: number): number {
  let total = 0;
  for (const b of parseBlocks(text)) {
    if (b.kind === "code") {
      const innerWidth = Math.max(1, width - CARD_PAD);
      // An empty fence still renders as one (blank) body row, same as Ink measuring "".
      total += 2 + Math.max(1, b.lines.reduce((n, l) => n + wrapCount(l, innerWidth), 0));
    } else if (b.kind === "list") {
      const innerWidth = Math.max(1, width - 2);
      total += b.items.reduce((n, spans) => n + wrapCount(spansToText(spans), innerWidth), 0);
    } else if (b.kind === "heading") {
      total += wrapCount(spansToText(b.spans), width);
    } else {
      total += wrapCount(spansToText(b.spans), width);
    }
  }
  return Math.max(total, 1);
}

/** Only run_bash's result actually starts with "exit N" — every other tool (show_image,
 * set_metric, ...) returns a plain success/error sentence, which used to get judged by
 * the SAME "exit 0" check and so always rendered as failed (✗) even on success. Tools'
 * error strings consistently start with "error" (see tools.ts), so that's the real signal
 * for anything that isn't run_bash. */
export function toolOk(result: string | null): boolean {
  if (result == null) return false;
  if (result.startsWith("exit ")) return result.startsWith("exit 0");
  return !result.toLowerCase().startsWith("error");
}

/** A compact one-line preview of a tool call's arguments. */
export function argsPreview(args: string): string {
  try {
    const o = JSON.parse(args);
    if (typeof o.command === "string") return o.command.split("\n")[0].slice(0, 80);
    return JSON.stringify(o).slice(0, 80);
  } catch {
    return args.slice(0, 80);
  }
}

/** The FULL command/args text — unlike argsPreview's one-line/80-char truncation, which
 * is all that was ever shown, even in an "expanded" card (the expanded view only added
 * the output, never the full command that produced it). For run_bash specifically this
 * is the actual multi-line command, not its JSON-escaped single-line form. */
export function fullArgsText(args: string): string {
  try {
    const o = JSON.parse(args);
    if (typeof o.command === "string") return o.command;
    return JSON.stringify(o, null, 2);
  } catch {
    return args;
  }
}

/** Char-wrap text into fixed-width physical lines. Single source of truth for wrapping,
 * so the estimator and the renderer can never disagree about how many rows something takes. */
export function wrapLines(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      out.push("");
      continue;
    }
    for (let i = 0; i < line.length; i += w) out.push(line.slice(i, i + w));
  }
  return out;
}

export function wrapCount(text: string, width: number): number {
  return wrapLines(text, width).length;
}

/** "47s", "3m12s", "1h05m" — for a running tool call's live elapsed time, so "still
 * running" distinguishes a legitimately long command from one that's actually dead
 * (e.g. the server restarted mid-exec — see store.ts's repairDanglingToolCalls). */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${String(rm).padStart(2, "0")}m`;
}

/** Layout constants shared between the estimator and the renderer — keep these in sync. */
export const TURN_INDENT = 2; // body text sits indented under its role badge
// Round border (1 col each side) + paddingX={1} (1 col each side) the card is rendered
// with — verified empirically (test/box-geometry.tsx): outer width includes BOTH.
export const CARD_PAD = 4;
export const MAX_CARD_LINES = 24; // clamp runaway tool output inside an expanded card
export const MAX_COMMAND_LINES = 8; // clamp a long command (e.g. a heredoc) inside the card

/**
 * Estimate how many terminal rows a block renders to. Used to pick a bottom-anchored
 * "window" of blocks that fits the pane, since Ink's column-reverse + overflow clipping
 * is unreliable across terminals — we do the clipping ourselves instead. MUST mirror
 * MessageBlock's actual rendering or the window will clip wrong / overflow.
 */
export function estimateLines(block: Block, width: number, expanded: boolean): number {
  const MARGIN = 1; // every block renders with a marginTop of 1
  switch (block.kind) {
    case "user":
    case "assistant":
    case "error":
      // one role-badge line + indented, block-rendered body (headings/lists/code/paras)
      return MARGIN + 1 + estimateMarkdownLines(block.text, Math.max(1, width - TURN_INDENT));
    case "info":
      return MARGIN + wrapCount(block.text, width);
    case "image": {
      // Terminals can't render a real image — one line (icon + caption/url), the PWA
      // is where this actually shows a picture (see web/src/components/MessageBlock).
      const text = `🖼 ${block.caption ? block.caption + " — " : ""}${block.url}`;
      return MARGIN + wrapCount(text, width);
    }
    case "thinking":
      if (!expanded) return MARGIN + 1;
      return MARGIN + 1 + estimateMarkdownLines(block.text, Math.max(1, width - TURN_INDENT));
    case "tool": {
      if (block.running || !expanded) return MARGIN + 1; // one-line, no border
      if (!block.result) return MARGIN + 1;
      const innerWidth = Math.max(1, width - CARD_PAD);
      const cmdLines = Math.min(wrapCount(fullArgsText(block.args), innerWidth), MAX_COMMAND_LINES);
      const outLines = Math.min(wrapCount(block.result, innerWidth), MAX_CARD_LINES);
      // top border + in-card header line (icon/name/preview) + full command + output + bottom border
      return MARGIN + 3 + cmdLines + outLines;
    }
  }
}

/**
 * Pick the longest suffix of `blocks` whose estimated rendered height fits within
 * `maxLines`, so the visible window is always anchored to the newest content.
 */
export function windowBlocks(blocks: Block[], width: number, expanded: boolean, maxLines: number): Block[] {
  let used = 0;
  let start = blocks.length;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const h = estimateLines(blocks[i], width, expanded);
    if (used + h > maxLines && start !== blocks.length) break;
    used += h;
    start = i;
    if (used >= maxLines) break;
  }
  return blocks.slice(start);
}

/** Fold one event into the block list. Returns a new array (immutable). */
export function applyEvent(blocks: Block[], e: AgentEvent, opts?: { optimistic?: boolean }): Block[] {
  switch (e.type) {
    case "user": {
      // Submitting while a turn is already busy shows your message instantly, locally,
      // before the server even starts it (it's just queued) — marked `pending`. The
      // REAL confirming event arrives later, often with other blocks (the current
      // turn's response, tool calls) now sitting in between, so a position-based "is it
      // the last block" dedup check fails and duplicates it (the "ghost message" bug).
      // Fix: confirm the oldest still-pending block with matching text wherever it is,
      // instead of only ever looking at the end.
      if (opts?.optimistic) return [...blocks, { kind: "user", text: e.content, pending: true }];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.kind === "user" && b.pending && b.text === e.content) {
          const copy = [...blocks];
          copy[i] = { ...b, pending: false };
          return copy;
        }
      }
      return [...blocks, { kind: "user", text: e.content }]; // e.g. fresh replay, no local echo existed
    }
    case "assistant_delta": {
      // Merge into the last block if it's the SAME kind (a live token continuing the
      // response in progress); otherwise start a new block. This naturally handles every
      // transition without a separate "streaming" flag: reasoning→content within one
      // turn breaks the kind-match (thinking → assistant), and a new turn always starts
      // with a "user" event pushed first (runtime.ts), which breaks it too — so deltas
      // can never accidentally merge into a stale block from an earlier turn.
      if (e.reasoning) {
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "thinking") return [...blocks.slice(0, -1), { ...last, text: last.text + e.reasoning }];
        return [...blocks, { kind: "thinking", text: e.reasoning }];
      }
      if (e.content) {
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "assistant") return [...blocks.slice(0, -1), { ...last, text: last.text + e.content }];
        return [...blocks, { kind: "assistant", text: e.content }];
      }
      return blocks;
    }
    case "tool_call":
      return [...blocks, { kind: "tool", name: e.name, args: e.args, result: null, running: true, startedAt: Date.now() }];
    case "tool_result": {
      const copy = [...blocks];
      for (let i = copy.length - 1; i >= 0; i--) {
        const b = copy[i];
        if (b.kind === "tool" && b.running) {
          copy[i] = { ...b, result: e.result, running: false };
          return copy;
        }
      }
      return copy;
    }
    case "error":
      return [...blocks, { kind: "error", text: e.message }];
    case "cancelled":
      return [...blocks, { kind: "info", text: "⏹ cancelled" }];
    case "compacting":
      return [...blocks, { kind: "info", text: "🗜 compacting older messages — this can take a little while on a big context…" }];
    case "compacted":
      return [...blocks, { kind: "info", text: `🗜 compacted ${e.throughIndex} earlier messages` }];
    case "retry":
      return [...blocks, { kind: "info", text: `🔁 ${e.reason}` }];
    case "image":
      return [...blocks, { kind: "image", url: e.url, caption: e.caption }];
    default:
      return blocks; // status / idle / done handled by the container
  }
}
