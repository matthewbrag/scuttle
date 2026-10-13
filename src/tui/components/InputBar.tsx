import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";

export function InputBar({ input, width }: { input: string; width: number }) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={theme.brandDim} width={width} paddingX={1}>
      <Text color={theme.brand} bold>
        {"› "}
      </Text>
      <Text>{input}</Text>
      <Text backgroundColor={theme.brand}> </Text>
    </Box>
  );
}
