/** "Nebula" — Scuttle's dark palette. One place to retune the whole UI. */
export const theme = {
  brand: "#a78bfa", // violet — the signature accent, section titles, borders
  brandDim: "#6d28d9", // deeper violet — inactive accents
  user: "#22d3ee", // cyan — your messages
  assistant: "#e9e4ff", // lavender-white — the agent's words
  assistantAccent: "#c4b5fd", // soft violet — agent role badge
  tool: "#fbbf24", // amber — tool calls
  toolDone: "#34d399", // green check once a tool finishes clean
  output: "#94a3b8", // slate — tool output
  thinking: "#8b7cc9", // muted purple — reasoning
  dim: "#52525b", // chrome: borders, hints, secondary text
  dim2: "#71717a", // slightly brighter dim, for readable secondary labels
  ok: "#34d399", // green — good / goal met
  warn: "#fbbf24", // amber — watch
  err: "#f87171", // red — errors
  barFill: "#a78bfa",
  barEmpty: "#3f3f46",
};

/** A unicode bar like ▓▓▓░░░ for the context/goal meters. */
export function meter(fraction: number, width = 8): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/** Braille spinner frames — smooth, compact, legible at 1 cell. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_INTERVAL_MS = 90;
