import React from "react";
import { render } from "ink";
import { App } from "./App";

/** Launch the full-screen TUI (alternate screen buffer, restored on exit). */
export async function start() {
  process.stdout.write("\x1b[?1049h\x1b[H"); // enter alt screen, cursor home
  const restore = () => process.stdout.write("\x1b[?1049l");
  process.on("exit", restore);
  // exitOnCtrlC: false — App.tsx handles Ctrl+C itself (cancel the running turn, or
  // exit if idle). With this true, Ink swallows Ctrl+C before useInput ever sees it.
  const { waitUntilExit } = render(<App />, { exitOnCtrlC: false });
  try {
    await waitUntilExit();
  } finally {
    restore();
  }
}

// Allow `tsx src/tui/index.tsx` directly.
if (import.meta.url === `file://${process.argv[1]}`) void start();
