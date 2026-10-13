import React from "react";
import { render } from "ink-testing-library";
import { Layout } from "../src/tui/components/Layout";
import type { Block } from "../src/tui/logic";
import { check, finish } from "./_check";

// Simulate a long-running session: far more blocks than fit a small terminal,
// built up incrementally (mimicking one event arriving at a time) to prove
// (a) the visible window stays bottom-anchored and within bounds, and
// (b) re-rendering with more blocks doesn't throw / blow past the frame.
const SIZE = { cols: 92, rows: 16 }; // deliberately small

let blocks: Block[] = [];
function append(b: Block) {
  blocks = [...blocks, b];
}

for (let i = 0; i < 40; i++) {
  append({ kind: "user", text: `message ${i}: do a thing` });
  append({ kind: "tool", name: "run_bash", args: `{"command":"echo step ${i}"}`, result: `exit 0\nstep ${i} output line a\nstep ${i} output line b`, running: false, startedAt: Date.now() });
  append({ kind: "assistant", text: `Done with step ${i}.` });
}

const { lastFrame, rerender } = render(
  <Layout size={SIZE} label="stress" model="qwen3-27b" running={false} frame={0} blocks={blocks} expanded={false} input="" />,
);

const frame = lastFrame() ?? "";
const frameLines = frame.split("\n");
console.log(`rendered ${frameLines.length} lines for a ${SIZE.rows}-row terminal (blocks total: ${blocks.length})`);
check("newest message visible", frame.includes("message 39"));
check("oldest messages correctly clipped", !frame.includes("message 0:"));
check("frame height roughly bounded", frameLines.length <= SIZE.rows + 2);

console.log("\n--- rendering one more incremental event (checking no crash / stable update) ---");
blocks = [...blocks, { kind: "assistant", text: "one more final message appended live" }];
rerender(<Layout size={SIZE} label="stress" model="qwen3-27b" running={false} frame={0} blocks={blocks} expanded={false} input="typing…" />);
const frame2 = lastFrame() ?? "";
check("incremental update renders", frame2.includes("one more final message appended live"));

console.log("\n--- full frame ---\n" + frame2);
finish();
