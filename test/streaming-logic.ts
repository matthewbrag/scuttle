import { applyEvent, type Block } from "../src/tui/logic";
import type { AgentEvent } from "../src/events";
import { check, finish } from "./_check";

let blocks: Block[] = [];
const apply = (e: AgentEvent) => {
  blocks = applyEvent(blocks, e);
};

// --- turn 1: reasoning streams token-by-token, then content streams token-by-token ---
apply({ type: "user", content: "say hi" });
for (const r of ["We", " need", " to", " respond"]) apply({ type: "assistant_delta", reasoning: r });
check("reasoning deltas merge into ONE thinking block", blocks.filter((b) => b.kind === "thinking").length === 1);
check(
  "merged thinking text is concatenated correctly",
  blocks.find((b) => b.kind === "thinking")?.text === "We need to respond",
);

for (const c of ["Hi", " there", "!"]) apply({ type: "assistant_delta", content: c });
check("switching to content starts a NEW assistant block (not merged into thinking)", blocks.filter((b) => b.kind === "assistant").length === 1);
check("merged content text is concatenated correctly", blocks.find((b) => b.kind === "assistant")?.text === "Hi there!");
check("thinking block from before is untouched", blocks.find((b) => b.kind === "thinking")?.text === "We need to respond");
check("exactly 3 blocks after turn 1 (user, thinking, assistant)", blocks.length === 3);

// --- a tool call interrupts: later content deltas must NOT merge into the earlier assistant block ---
apply({ type: "tool_call", name: "run_bash", args: '{"command":"ls"}' });
apply({ type: "tool_result", name: "run_bash", result: "exit 0\nfile.txt" });
for (const c of ["All", " done", "."]) apply({ type: "assistant_delta", content: c });
const assistantBlocks1 = blocks.filter((b) => b.kind === "assistant");
check("tool call in between produces a SEPARATE second assistant block", assistantBlocks1.length === 2);
check("second assistant block has its own correct text", assistantBlocks1[1]?.text === "All done.");
check("first assistant block ('Hi there!') unchanged by the second", assistantBlocks1[0]?.text === "Hi there!");

// --- turn 2: a fresh user message must NOT let new deltas merge into turn 1's stale assistant block ---
apply({ type: "user", content: "now what's 2+2" });
for (const c of ["It's", " 4"]) apply({ type: "assistant_delta", content: c });
const assistantBlocks2 = blocks.filter((b) => b.kind === "assistant");
check("new turn starts its own assistant block, doesn't merge into turn 1's", assistantBlocks2.length === 3);
check("new turn's block has correct, uncontaminated text", assistantBlocks2[2]?.text === "It's 4");
check("turn 1's final assistant block is still exactly 'All done.'", assistantBlocks2[1]?.text === "All done.");

console.log("\ndone.");
finish();
