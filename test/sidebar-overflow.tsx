import React from "react";
import { render } from "ink-testing-library";
import { Sidebar } from "../src/tui/components/Sidebar";

// Isolate: does Sidebar render correctly when its natural content height EXCEEDS
// the fixed `height` it's given (forcing overflow:"hidden" to actually clip)?
console.log("--- height=16 (likely too short for 2 panels) ---");
{
  const { lastFrame } = render(
    <Sidebar
      height={16}
      stats={{ ctxUsed: 12400, ctxMax: 196608, tokPerSec: 87, specAccept: 0.93, elapsedMs: 3200, turn: 4 }}
      indicators={[
        { name: "train loss", value: "0.17", trend: "down", spark: "▁▃▂▅▄▆▇", goal: "0.05" },
        { name: "throughput", value: "4.2k ex/s" },
        { name: "gpu mem", value: "3.9/24 GB" },
      ]}
    />,
  );
  console.log(lastFrame());
}

console.log("\n--- height=40 (plenty of room, no clipping needed) ---");
{
  const { lastFrame } = render(
    <Sidebar
      height={40}
      stats={{ ctxUsed: 12400, ctxMax: 196608, tokPerSec: 87, specAccept: 0.93, elapsedMs: 3200, turn: 4 }}
      indicators={[
        { name: "train loss", value: "0.17", trend: "down", spark: "▁▃▂▅▄▆▇", goal: "0.05" },
        { name: "throughput", value: "4.2k ex/s" },
        { name: "gpu mem", value: "3.9/24 GB" },
      ]}
    />,
  );
  console.log(lastFrame());
}
