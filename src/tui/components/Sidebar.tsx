import React from "react";
import { Box, Text } from "ink";
import { theme, meter } from "../theme";
import { wrapCount } from "../logic";

export const SIDEBAR_W = 32;
const INNER_W = SIDEBAR_W - 4; // round border (2) + paddingX={1} (2) — verified in test/box-geometry.tsx
const PANEL_CHROME = 3; // border top + title line + border bottom (marginBottom added separately)

export interface Indicator {
  name: string;
  value: string;
  goal?: string;
  spark?: string;
  trend?: "up" | "down";
}

export interface Stats {
  ctxUsed?: number;
  ctxMax?: number;
  tokPerSec?: number;
  specAccept?: number;
  elapsedMs?: number;
  turn?: number;
  cachedTokens?: number;
}

export interface ResourceStats {
  cpuPercent?: number;
  memUsedMB?: number;
  memLimitMB?: number;
  gpuUtilPercent?: number;
  gpuMemUsedMB?: number;
  gpuMemTotalMB?: number;
}

const fmt = (n?: number) => (n == null ? "—" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const fmtMB = (n?: number) => (n == null ? "—" : n >= 1024 ? (n / 1024).toFixed(1) + "G" : Math.round(n) + "M");

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  // flexShrink=0: without it, Yoga will compress this box below its content's natural
  // height when the sidebar's total content doesn't fit — and since this is a BORDERED
  // box, a shrunk height draws the bottom border too early, overlapping/corrupting the
  // remaining text instead of cleanly overflowing. We size everything ourselves (see
  // Sidebar's fitting math below) specifically so this box is never asked to shrink.
  return (
    <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor={theme.dim} paddingX={1} marginBottom={1}>
      <Text color={theme.brand} bold>
        {title}
      </Text>
      {children}
    </Box>
  );
}

/** `ctxMeter` is kept separate (not folded into `ctx`'s string) only so the render can
 * color it differently — `ctx` is still the exact full-line text used for measurement.
 * `cached` is null (not a "—" row) when the server hasn't reported it yet, same
 * omit-rather-than-placeholder convention as resourceLines' `gpu` below. */
function perfLines(stats: Stats): { ctxMeter: string; ctxRest: string; ctx: string; speed: string; turn: string; cached: string | null } {
  const s = stats;
  const ctxFrac = s.ctxUsed && s.ctxMax ? s.ctxUsed / s.ctxMax : 0;
  const ctxPct = s.ctxUsed && s.ctxMax ? Math.round((s.ctxUsed / s.ctxMax) * 100) : null;
  const ctxMeter = meter(ctxFrac);
  const ctxRest = ` ${fmt(s.ctxUsed)}/${fmt(s.ctxMax)}${ctxPct != null ? ` (${ctxPct}%)` : ""}`;
  const cachedPct = s.cachedTokens != null && s.ctxUsed ? Math.round((s.cachedTokens / s.ctxUsed) * 100) : null;
  return {
    ctxMeter,
    ctxRest,
    ctx: `ctx ${ctxMeter}${ctxRest}`,
    speed:
      (s.tokPerSec != null ? `${s.tokPerSec.toFixed(0)} tok/s` : "— tok/s") +
      (s.specAccept != null ? `  ·  spec ${(s.specAccept * 100).toFixed(0)}%` : ""),
    turn:
      (s.elapsedMs != null ? `⏱ ${(s.elapsedMs / 1000).toFixed(1)}s` : "⏱ —") +
      (s.turn != null ? `  ·  turn ${s.turn}` : ""),
    cached: s.cachedTokens != null ? `${fmt(s.cachedTokens)} cached${cachedPct != null ? ` (${cachedPct}%)` : ""}` : null,
  };
}

function resourceLines(r: ResourceStats): { cpuMem: string; gpu: string | null } {
  const cpuMem =
    (r.cpuPercent != null ? `cpu ${r.cpuPercent.toFixed(0)}%` : "cpu —") +
    `  ·  mem ${fmtMB(r.memUsedMB)}/${fmtMB(r.memLimitMB)}`;
  const gpu =
    r.gpuUtilPercent != null || r.gpuMemUsedMB != null
      ? `gpu ${r.gpuUtilPercent != null ? r.gpuUtilPercent.toFixed(0) + "%" : "—"}  ·  vram ${fmtMB(r.gpuMemUsedMB)}/${fmtMB(r.gpuMemTotalMB)}`
      : null; // omitted entirely on machines without an NVIDIA GPU — not a "—" row, just absent
  return { cpuMem, gpu };
}

export function Sidebar({
  stats,
  resources,
  indicators,
  height,
}: {
  stats?: Stats;
  resources?: ResourceStats;
  indicators?: Indicator[];
  height: number;
}) {
  const s = stats ?? {};
  const r = resources ?? {};
  const perf = perfLines(s);
  const res = resourceLines(r);

  const perfContentLines =
    wrapCount(perf.ctx, INNER_W) +
    wrapCount(perf.speed, INNER_W) +
    wrapCount(perf.turn, INNER_W) +
    (perf.cached ? wrapCount(perf.cached, INNER_W) : 0);
  const perfHeight = PANEL_CHROME + perfContentLines;

  const resContentLines = wrapCount(res.cpuMem, INNER_W) + (res.gpu ? wrapCount(res.gpu, INNER_W) : 0);
  const resHeight = PANEL_CHROME + resContentLines;

  // Ink's overflow:"hidden" does NOT reliably clip a nested-bordered Box that exceeds its
  // parent's fixed height (verified in test/sidebar-overflow.tsx — it garbles rather than
  // crops). So we decide ourselves how many indicators fit, same principle as the main
  // pane's windowBlocks: measure first, render only what provably fits.
  const list = indicators ?? [];
  let used = PANEL_CHROME; // indicators panel's own border+title
  let shown = 0;
  const fixedHeight = perfHeight + 1 + resHeight + 1; // the two fixed panels + their marginBottoms
  for (const ind of list) {
    const nameLine = `${ind.name}  ${ind.value}${ind.trend ? (ind.trend === "down" ? " ↓" : " ↑") : ""}`;
    const subLine = ind.spark || ind.goal ? `${ind.spark ? ind.spark + " " : ""}${ind.goal ? `→ ${ind.goal}` : ""}` : null;
    const cost = wrapCount(nameLine, INNER_W) + (subLine ? wrapCount(subLine, INNER_W) : 0) + 1; // +1 marginBottom
    const remainingBudget = height - fixedHeight - used;
    const reserveForMore = shown < list.length - 1 ? 1 : 0; // keep 1 line free for a "+N more" note
    if (cost > remainingBudget - reserveForMore) break;
    used += cost;
    shown++;
  }
  const hidden = list.length - shown;
  const visible = list.slice(0, shown);

  return (
    <Box width={SIDEBAR_W} height={height} flexDirection="column" paddingLeft={1}>
      <Panel title="PERFORMANCE">
        <Text color={theme.dim2}>
          {"ctx "}
          <Text color={theme.brand}>{perf.ctxMeter}</Text>
          {perf.ctxRest}
        </Text>
        <Text color={theme.dim2}>{perf.speed}</Text>
        <Text color={theme.dim2}>{perf.turn}</Text>
        {perf.cached ? <Text color={theme.dim2}>{perf.cached}</Text> : null}
      </Panel>

      <Panel title="RESOURCES">
        <Text color={theme.dim2}>{res.cpuMem}</Text>
        {res.gpu ? <Text color={theme.dim2}>{res.gpu}</Text> : null}
      </Panel>

      <Panel title="INDICATORS">
        {visible.length ? (
          visible.map((ind) => (
            <Box key={ind.name} flexDirection="column" marginBottom={1}>
              <Text>
                <Text color={theme.assistantAccent}>{ind.name}</Text>
                <Text color={theme.ok} bold>
                  {"  " + ind.value}
                </Text>
                {ind.trend ? <Text color={theme.dim2}>{ind.trend === "down" ? " ↓" : " ↑"}</Text> : null}
              </Text>
              {(ind.spark || ind.goal) && (
                <Text color={theme.dim}>
                  {ind.spark ? ind.spark + " " : ""}
                  {ind.goal ? `→ ${ind.goal}` : ""}
                </Text>
              )}
            </Box>
          ))
        ) : (
          <Text color={theme.dim}>none yet</Text>
        )}
        {hidden > 0 ? <Text color={theme.dim}>+{hidden} more…</Text> : null}
      </Panel>
    </Box>
  );
}
