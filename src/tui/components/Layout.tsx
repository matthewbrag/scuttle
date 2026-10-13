import React from "react";
import { Box } from "ink";
import { windowBlocks, type Block } from "../logic";
import { Header } from "./Header";
import { Sidebar, SIDEBAR_W, type Stats, type ResourceStats, type Indicator } from "./Sidebar";
import { MessageBlock } from "./MessageBlock";
import { InputBar } from "./InputBar";
import { CommandMenu } from "./CommandMenu";
import { matchCommands } from "../../commands";

export type { Stats, ResourceStats, Indicator };

export interface LayoutProps {
  size: { cols: number; rows: number };
  label: string;
  model: string;
  running: boolean;
  frame: number; // ticks while `running`, drives the spinner
  blocks: Block[];
  scrolled?: boolean; // true when viewing scrollback, not the live tail
  expanded: boolean;
  input: string;
  cmdIndex?: number; // selected row in the slash-command popup, when it's showing
  stats?: Stats;
  resources?: ResourceStats;
  indicators?: Indicator[];
}

// Fixed chrome heights — MUST match what Header/InputBar actually render (see
// test/tui-stress.tsx, which asserts the frame never exceeds the terminal).
const HEADER_H = 2; // content line + its bottom border
const INPUT_H = 4; // marginTop gap (1) + bordered box: top border + input line + bottom border (3)

export function Layout(props: LayoutProps) {
  const { size, label, model, running, frame, blocks, scrolled, expanded, input, cmdIndex, stats, resources, indicators } = props;
  const mainW = size.cols - SIDEBAR_W;
  const contentW = Math.max(10, mainW - 1); // minus the pane's left padding

  // Bounded to the fixed COMMANDS list (max 7), so a flat "+2 border rows" is exact —
  // no self-measuring needed the way the sidebar/transcript require for unbounded content.
  const menuMatches = input.startsWith("/") && !input.includes(" ") ? matchCommands(input) : [];
  const menuH = menuMatches.length ? menuMatches.length + 2 : 0;

  const mainH = Math.max(1, size.rows - HEADER_H - INPUT_H - menuH);

  // Bottom-anchored window sized to the pane. Ink's own overflow/reverse clipping is
  // unreliable across terminals, so we compute which blocks fit ourselves (logic.ts),
  // and give each a key tied to its permanent index so React never remounts the
  // blocks that haven't changed.
  const windowed = windowBlocks(blocks, contentW, expanded, mainH);
  const firstIndex = blocks.length - windowed.length;
  const runningIdx = blocks.length - 1; // only the trailing block can still be running

  return (
    <Box flexDirection="column" width={size.cols} height={size.rows}>
      <Header label={label} model={model} running={running} frame={frame} scrolled={scrolled} width={size.cols} />
      <Box height={mainH} flexDirection="row">
        <Box width={mainW} height={mainH} flexDirection="column" justifyContent="flex-end" overflow="hidden" paddingLeft={1}>
          {windowed.map((b, i) => {
            const idx = firstIndex + i;
            const isLiveTool = b.kind === "tool" && b.running && idx === runningIdx;
            return (
              <MessageBlock
                key={idx}
                block={b}
                expanded={expanded}
                width={contentW}
                spinnerFrame={isLiveTool ? frame : undefined}
              />
            );
          })}
        </Box>
        <Sidebar stats={stats} resources={resources} indicators={indicators} height={mainH} />
      </Box>
      <CommandMenu matches={menuMatches} selected={cmdIndex ?? 0} width={size.cols} />
      <InputBar input={input} width={size.cols} />
    </Box>
  );
}
