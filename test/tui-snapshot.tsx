import React from "react";
import { render } from "ink-testing-library";
import { Layout } from "../src/tui/components/Layout";
import type { Block } from "../src/tui/logic";

const blocks: Block[] = [
  { kind: "user", text: "train a tiny MLP and track the loss" },
  { kind: "thinking", text: "I'll write a training script and expose loss as an indicator." },
  { kind: "tool", name: "run_bash", args: '{"command":"python train.py"}', result: "exit 0\nepoch 3/10  loss 0.42\nepoch 4/10  loss 0.31", running: false, startedAt: Date.now() },
  { kind: "assistant", text: "Training is converging nicely — loss is down to 0.31." },
  { kind: "tool", name: "run_bash", args: '{"command":"python eval.py --final"}', result: null, running: true, startedAt: Date.now() - 5000 },
];

const { lastFrame } = render(
  <Layout
    size={{ cols: 92, rows: 22 }}
    label="track training loss"
    model="qwen3-27b"
    running={true}
    frame={2}
    blocks={blocks}
    expanded={false}
    input="now benchmark fp16"
    stats={{ ctxUsed: 12400, ctxMax: 196608, tokPerSec: 87, specAccept: 0.93, elapsedMs: 3200, turn: 4 }}
    indicators={[
      { name: "train loss", value: "0.17", trend: "down", spark: "▁▃▂▅▄▆▇", goal: "0.05" },
      { name: "throughput", value: "4.2k ex/s" },
      { name: "gpu mem", value: "3.9/24 GB" },
    ]}
  />,
);

console.log("=== collapsed ===");
console.log(lastFrame());

const expandedRender = render(
  <Layout
    size={{ cols: 92, rows: 26 }}
    label="track training loss"
    model="qwen3-27b"
    running={true}
    frame={2}
    blocks={blocks}
    expanded={true}
    input="now benchmark fp16"
    stats={{ ctxUsed: 12400, ctxMax: 196608, tokPerSec: 87, specAccept: 0.93, elapsedMs: 3200, turn: 4 }}
    indicators={[
      { name: "train loss", value: "0.17", trend: "down", spark: "▁▃▂▅▄▆▇", goal: "0.05" },
      { name: "throughput", value: "4.2k ex/s" },
      { name: "gpu mem", value: "3.9/24 GB" },
    ]}
  />,
);
console.log("\n=== expanded (tab) ===");
console.log(expandedRender.lastFrame());
