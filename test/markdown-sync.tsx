import React from "react";
import { render } from "ink-testing-library";
import { Layout } from "../src/tui/components/Layout";
import { parseInline, plainText, type Block } from "../src/tui/logic";
import { check, finish } from "./_check";

// --- 1. parseInline / plainText correctness ---
{
  const spans = parseInline("Run **npm install** then check `package.json` for **the** version.");
  check("bold span extracted correctly", spans.some((s) => s.bold && s.text === "npm install"));
  check("code span extracted correctly", spans.some((s) => s.code && s.text === "package.json"));
  check(
    "plainText strips markers, keeps visible text",
    plainText("Run **npm install** then check `package.json` for **the** version.") ===
      "Run npm install then check package.json for the version.",
  );
  check("unterminated marker falls through as literal text", plainText("this **never closes") === "this **never closes");
}

// --- 2. does the windowing system stay exactly bounded with heavy bold/code content mixed in?
// This is the real thing that matters — same proof methodology as test/tui-stress.tsx, just
// with markdown-laden text instead of plain, since that's where an estimate/render desync
// would actually surface (as a frame taller than the terminal, or garbled text).
let blocks: Block[] = [];
for (let i = 0; i < 25; i++) {
  blocks.push({ kind: "user", text: `task ${i}: install **the ${i}th package** please` });
  blocks.push({
    kind: "assistant",
    text: `Running \`npm install pkg-${i}\` now. This installs **a bunch of transitive deps** and should finish in **under a minute** for task ${i}.`,
  });
}

const SIZE = { cols: 80, rows: 18 };
const { lastFrame } = render(
  <Layout size={SIZE} label="markdown stress" model="m" running={false} frame={0} blocks={blocks} expanded={false} input="" />,
);
const frame = lastFrame() ?? "";
const frameLines = frame.split("\n");

check("frame height exactly matches terminal rows (no overflow)", frameLines.length === SIZE.rows);
check("newest content visible", frame.includes("task 24"));
check("markdown markers are stripped from rendered output (no literal **)", !frame.includes("**"));
check("markdown markers are stripped (no literal backtick)", !frame.includes("`"));
check("bold text content still present (just unstyled asterisks gone)", frame.includes("transitive deps"));

console.log("\n--- actual frame ---");
console.log(frame);
finish();
