import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";
import type { CommandSpec } from "../../commands";

/** Shown above the input while composing a "/command" — bounded to the fixed COMMANDS
 * list (7 entries max), so unlike the sidebar/transcript this doesn't need the
 * self-measuring overflow discipline used elsewhere; it always fits. */
export function CommandMenu({ matches, selected, width }: { matches: CommandSpec[]; selected: number; width: number }) {
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor={theme.brandDim} paddingX={1}>
      {matches.map((c, i) => (
        <Text key={c.name} color={i === selected ? theme.brand : theme.dim2} bold={i === selected}>
          {i === selected ? "▸ " : "  "}/{c.name}
          {c.hint ? ` ${c.hint}` : ""}
          <Text color={theme.dim}>{"  " + c.description}</Text>
        </Text>
      ))}
    </Box>
  );
}
