import React from "react";
import type { CommandSpec } from "../../../src/commands";

/** Shown above the input while composing a "/command" — mirrors tui/components/CommandMenu.tsx. */
export function CommandMenu({ matches, selected }: { matches: CommandSpec[]; selected: number }) {
  if (matches.length === 0) return null;
  return (
    <div className="command-menu">
      {matches.map((c, i) => (
        <div key={c.name} className={`command-row ${i === selected ? "selected" : ""}`}>
          <span className="command-name">
            /{c.name}
            {c.hint ? ` ${c.hint}` : ""}
          </span>
          <span className="command-desc">{c.description}</span>
        </div>
      ))}
    </div>
  );
}
