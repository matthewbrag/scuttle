/** Slash-command metadata — shared by the TUI and the PWA so the "type / for a menu"
 * popup in both UIs stays in sync with one list, even though each UI implements its own
 * command EXECUTION (they differ slightly: e.g. the PWA has no local terminal process to
 * exit). Pure data, no framework dependency, safe for either client to import. */
export interface CommandSpec {
  name: string; // without the leading /
  hint?: string; // e.g. "<id>" — shown after the name in the menu
  description: string;
}

export const COMMANDS: CommandSpec[] = [
  { name: "sessions", description: "list sessions and pick one to open" },
  { name: "open", hint: "<n|id>", description: "attach to a session" },
  { name: "new", description: "start a fresh session" },
  { name: "compact", description: "summarize older context now, instead of waiting for the threshold" },
  { name: "stop", description: "park the current session (keeps it, frees resources)" },
  { name: "rm", hint: "<id>", description: "delete a session" },
  { name: "exit", description: "quit" },
];

/** Commands matching what's typed after "/", for the live-filtered popup. */
export function matchCommands(input: string): CommandSpec[] {
  const q = input.replace(/^\//, "").toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q));
}
