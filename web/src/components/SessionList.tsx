import React from "react";
import type { SessionSummary } from "../App";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function SessionList({
  sessions,
  currentId,
  onOpen,
  onNew,
  visible,
}: {
  sessions: SessionSummary[];
  currentId: string | null;
  onOpen: (id: string, s: SessionSummary) => void;
  onNew: () => void;
  visible: boolean;
}) {
  return (
    <aside className={`session-list ${visible ? "visible" : ""}`}>
      <div className="session-list-header">
        <span className="brand">✦ scuttle</span>
        <button className="new-btn" onClick={onNew} title="New session">
          + new
        </button>
      </div>
      <div className="session-items">
        {sessions.length === 0 && <div className="empty-hint">no sessions yet</div>}
        {sessions.map((s) => (
          <button
            key={s.id}
            className={`session-item ${s.id === currentId ? "active" : ""}`}
            onClick={() => onOpen(s.id, s)}
          >
            <span className={s.busy ? "dot running" : s.status === "running" ? "dot ok" : "dot"}>●</span>
            <span className="session-item-body">
              <span className="session-item-summary">{s.summary || "(new)"}</span>
              <span className="session-item-path">{s.projectPath}</span>
            </span>
            <span className="session-item-time">{timeAgo(s.updatedAt)}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
