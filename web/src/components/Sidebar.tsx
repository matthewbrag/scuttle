import React from "react";
import type { Indicator } from "../App";

export interface Stats {
  ctxUsed?: number;
  ctxMax?: number;
  tokPerSec?: number;
  specAccept?: number;
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

const fmt = (n?: number) => (n == null ? "—" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));
const fmtMB = (n?: number) => (n == null ? "—" : n >= 1024 ? (n / 1024).toFixed(1) + "G" : Math.round(n) + "M");

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="sidebar-panel">
      <div className="sidebar-panel-title">{title}</div>
      {children}
    </div>
  );
}

// Desktop/PWA only — hidden under 1000px via CSS (see .sidebar in app.css). There
// usually isn't room for this on a phone screen, per explicit user feedback. No manual
// height-budgeting here (unlike the TUI's Sidebar) — the browser just scrolls natively,
// one of the small conveniences of not being a terminal.
export function Sidebar({
  stats,
  resources,
  indicators,
}: {
  stats: Stats;
  resources: ResourceStats;
  indicators: Indicator[];
}) {
  const ctxFrac = stats.ctxUsed && stats.ctxMax ? stats.ctxUsed / stats.ctxMax : 0;
  const hasGpu = resources.gpuUtilPercent != null || resources.gpuMemUsedMB != null;

  return (
    <aside className="sidebar">
      <Panel title="PERFORMANCE">
        <div className="perf-row">
          <span className="dim2">ctx</span>
          <div className="meter">
            <div className="meter-fill" style={{ width: `${Math.round(ctxFrac * 100)}%` }} />
          </div>
          <span className="dim2">
            {fmt(stats.ctxUsed)}/{fmt(stats.ctxMax)}
          </span>
        </div>
        {stats.cachedTokens != null && (
          <div className="perf-row dim2">{fmt(stats.cachedTokens)} cached ({stats.ctxUsed ? Math.round((stats.cachedTokens / stats.ctxUsed) * 100) : 0}%)</div>
        )}
        <div className="perf-row dim2">
          {stats.tokPerSec != null ? `${stats.tokPerSec.toFixed(0)} tok/s` : "— tok/s"}
          {stats.specAccept != null ? `  ·  spec ${(stats.specAccept * 100).toFixed(0)}%` : ""}
        </div>
      </Panel>

      <Panel title="RESOURCES">
        <div className="perf-row dim2">
          {resources.cpuPercent != null ? `cpu ${resources.cpuPercent.toFixed(0)}%` : "cpu —"}
          {"  ·  mem " + fmtMB(resources.memUsedMB) + "/" + fmtMB(resources.memLimitMB)}
        </div>
        {hasGpu && (
          <div className="perf-row dim2">
            {resources.gpuUtilPercent != null ? `gpu ${resources.gpuUtilPercent.toFixed(0)}%` : "gpu —"}
            {"  ·  vram " + fmtMB(resources.gpuMemUsedMB) + "/" + fmtMB(resources.gpuMemTotalMB)}
          </div>
        )}
      </Panel>

      <Panel title="INDICATORS">
        {indicators.length === 0 ? (
          <div className="sidebar-empty">none yet</div>
        ) : (
          indicators.map((ind) => (
            <div key={ind.name} className="indicator">
              <div className="indicator-row">
                <span className="indicator-name">{ind.name}</span>
                <span className="indicator-value">{ind.value}</span>
                {ind.trend && <span className="indicator-trend">{ind.trend === "down" ? "↓" : "↑"}</span>}
              </div>
              {ind.goal && <div className="indicator-goal">→ {ind.goal}</div>}
            </div>
          ))
        )}
      </Panel>
    </aside>
  );
}
