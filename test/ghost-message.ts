import { applyEvent, type Block } from "../src/tui/logic";
import type { AgentEvent } from "../src/events";
import { check, finish } from "./_check";

let blocks: Block[] = [];
const apply = (e: AgentEvent, optimistic = false) => {
  blocks = applyEvent(blocks, e, { optimistic });
};

// Reproduces exactly what happens when you type a second message WHILE the agent is
// still busy with the first: App.tsx's submit() optimistically shows your message
// LOCALLY the instant you hit Enter — before the server has even started processing
// it (it's just queued behind the current turn). When the queued turn eventually
// starts, runtime.ts's drain() loop emits a REAL {type:"user"} event for it too.

// Turn 1 is already running when the user sends message 2.
apply({ type: "user", content: "message 1" });
apply({ type: "assistant_delta", content: "working on it" });

// User types message 2 WHILE turn 1 is still busy. App.tsx's submit() adds this
// OPTIMISTICALLY, locally, right away:
apply({ type: "user", content: "message 2 (typed while busy)" }, true);

// Turn 1 keeps going and finishes (more blocks get appended AFTER the optimistic echo).
apply({ type: "assistant_delta", content: " — still finishing turn 1" });
apply({ type: "tool_call", name: "run_bash", args: '{"command":"ls"}' });
apply({ type: "tool_result", name: "run_bash", result: "exit 0\nfile.txt" });

// NOW turn 2 (message 2) actually starts server-side. runtime.ts's drain() loop emits
// the REAL {type:"user"} event for it — SAME text as the optimistic one sent earlier.
apply({ type: "user", content: "message 2 (typed while busy)" });

const userBlocks = blocks.filter((b) => b.kind === "user");
console.log(`user blocks found: ${userBlocks.length}`);
userBlocks.forEach((b, i) => console.log(`  [${i}] ${JSON.stringify((b as any).text)} pending=${(b as any).pending}`));

check(
  "message 2 does NOT appear twice (the 'ghost' duplicate)",
  userBlocks.filter((b) => (b as any).text === "message 2 (typed while busy)").length === 1,
);
check(
  "the confirmed message 2 block is no longer marked pending",
  userBlocks.find((b) => (b as any).text === "message 2 (typed while busy)")?.pending === false,
);

// --- edge case: the exact same text queued twice should confirm FIFO (oldest first) ---
blocks = [];
apply({ type: "user", content: "turn" });
apply({ type: "user", content: "dup" }, true); // optimistic #1
apply({ type: "user", content: "dup" }, true); // optimistic #2 (identical text, still pending)
apply({ type: "user", content: "dup" }); // real confirmation for the FIRST queued "dup"
const dupBlocks = blocks.filter((b) => b.kind === "user" && (b as any).text === "dup");
check("two identical pending messages: exactly 2 blocks, not merged/lost", dupBlocks.length === 2);
check(
  "FIFO: the OLDEST pending 'dup' got confirmed first, not the newest",
  (dupBlocks[0] as any).pending === false && (dupBlocks[1] as any).pending === true,
);

finish();
