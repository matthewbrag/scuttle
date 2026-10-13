import React from "react";
import { Text } from "ink";
import { theme, SPINNER_FRAMES } from "../theme";

/** Presentational only — `frame` is ticked once centrally in App and threaded down,
 * so only the actually-animating bits (status dot, the one running tool card) re-render. */
export function Spinner({ frame, color = theme.tool }: { frame: number; color?: string }) {
  return <Text color={color}>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</Text>;
}
