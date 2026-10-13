import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";
import { Spinner } from "./Spinner";

export function Header({
  label,
  model,
  running,
  frame,
  scrolled,
  width,
}: {
  label: string;
  model: string;
  running: boolean;
  frame: number;
  scrolled?: boolean;
  width: number;
}) {
  return (
    <Box
      width={width}
      justifyContent="space-between"
      borderStyle="single"
      borderColor={theme.dim}
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
    >
      <Text>
        <Text color={theme.brand} bold>
          ✦ scuttle
        </Text>
        <Text color={theme.dim}> › </Text>
        <Text color={theme.dim2}>{label}</Text>
      </Text>
      <Text>
        {scrolled ? <Text color={theme.warn}>↑ scrolled — ↓ to catch up  </Text> : null}
        {running ? <Spinner frame={frame} color={theme.ok} /> : <Text color={theme.dim}>○</Text>}
        <Text color={running ? theme.ok : theme.dim}> {running ? "running" : "idle"} </Text>
        <Text color={theme.dim}>· </Text>
        <Text color={theme.dim2}>{model}</Text>
      </Text>
    </Box>
  );
}
