import React, { memo } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";
import {
  argsPreview,
  wrapLines,
  parseBlocks,
  toolOk,
  CARD_PAD,
  MAX_CARD_LINES,
  type Block,
  type Span,
} from "../logic";
import { Spinner } from "./Spinner";

function Spans({ spans, baseColor }: { spans: Span[]; baseColor: string }) {
  return (
    <Text color={baseColor}>
      {spans.map((s, i) =>
        s.code ? (
          <Text key={i} color={theme.tool}>
            {s.text}
          </Text>
        ) : s.bold ? (
          <Text key={i} bold>
            {s.text}
          </Text>
        ) : s.italic ? (
          <Text key={i} italic>
            {s.text}
          </Text>
        ) : (
          <Text key={i}>{s.text}</Text>
        ),
      )}
    </Text>
  );
}

/** Renders a message body as block-level markdown — fenced code (bordered card, like a
 * tool result), headings, lists, and plain paragraphs. Must mirror estimateMarkdownLines
 * in logic.ts line-for-line, or the bottom-anchored windowing clips wrong. */
function MarkdownBody({ text, width, baseColor }: { text: string; width: number; baseColor: string }) {
  return (
    <Box flexDirection="column" width={width}>
      {parseBlocks(text).map((b, i) => {
        if (b.kind === "code") {
          const innerWidth = Math.max(1, width - CARD_PAD);
          const body = b.lines.flatMap((l) => wrapLines(l, innerWidth)).join("\n");
          return (
            <Box key={i} flexDirection="column" borderStyle="round" borderColor={theme.dim} paddingX={1} width={width}>
              <Text color={theme.output} wrap="truncate-end">
                {body}
              </Text>
            </Box>
          );
        }
        if (b.kind === "heading") {
          return (
            <Text key={i} bold>
              <Spans spans={b.spans} baseColor={baseColor} />
            </Text>
          );
        }
        if (b.kind === "list") {
          return (
            <Box key={i} flexDirection="column">
              {b.items.map((spans, j) => (
                <Text key={j} color={baseColor}>
                  {b.ordered ? `${j + 1}. ` : "• "}
                  <Spans spans={spans} baseColor={baseColor} />
                </Text>
              ))}
            </Box>
          );
        }
        return <Spans key={i} spans={b.spans} baseColor={baseColor} />;
      })}
    </Box>
  );
}

function Turn({ role, color, text, width }: { role: string; color: string; text: string; width: number }) {
  return (
    <Box flexDirection="column" marginTop={1} width={width}>
      <Text color={color} bold>
        {role}
      </Text>
      <Box paddingLeft={2} width={width}>
        <MarkdownBody text={text} width={width - 2} baseColor={color === theme.err ? theme.err : theme.assistant} />
      </Box>
    </Box>
  );
}

export const MessageBlock = memo(function MessageBlock({
  block,
  expanded,
  width,
  spinnerFrame,
}: {
  block: Block;
  expanded: boolean;
  width: number;
  /** Only set for the single currently-running block — keeps everything else memo-stable. */
  spinnerFrame?: number;
}) {
  switch (block.kind) {
    case "user":
      return <Turn role="▌ YOU" color={theme.user} text={block.text} width={width} />;

    case "assistant":
      return <Turn role="✦ SCUTTLE" color={theme.assistantAccent} text={block.text} width={width} />;

    case "error":
      return <Turn role="✖ ERROR" color={theme.err} text={block.text} width={width} />;

    case "info":
      return (
        <Box marginTop={1} width={width}>
          <Text color={theme.dim2}>{block.text}</Text>
        </Box>
      );

    case "image":
      // Terminals can't render a real image — the PWA is where this actually shows a
      // picture (web/src/components/MessageBlock.tsx renders a real <img>).
      return (
        <Box marginTop={1} width={width}>
          <Text color={theme.dim2}>
            🖼 {block.caption ? block.caption + " — " : ""}
            <Text color={theme.brand}>{block.url}</Text>
            <Text color={theme.dim}> (view in PWA)</Text>
          </Text>
        </Box>
      );

    case "thinking": {
      const lines = block.text.split("\n").length;
      if (!expanded)
        return (
          <Box marginTop={1}>
            <Text color={theme.thinking} dimColor>
              ◇ thinking ({lines} {lines === 1 ? "line" : "lines"}) ▸
            </Text>
          </Box>
        );
      return (
        <Box flexDirection="column" marginTop={1} width={width}>
          <Text color={theme.thinking}>◇ thinking ▾</Text>
          <Box paddingLeft={2} width={width}>
            <Text color={theme.thinking} italic>
              {block.text}
            </Text>
          </Box>
        </Box>
      );
    }

    case "tool": {
      const preview = argsPreview(block.args).slice(0, Math.max(10, width - block.name.length - 8));

      if (block.running) {
        return (
          <Box marginTop={1}>
            <Text>
              {spinnerFrame != null ? <Spinner frame={spinnerFrame} /> : <Text color={theme.tool}>⠋</Text>}
              <Text color={theme.tool} bold>
                {" " + block.name}
              </Text>
              <Text color={theme.dim2}> {preview}</Text>
              <Text color={theme.dim}> …</Text>
            </Text>
          </Box>
        );
      }

      const ok = toolOk(block.result);
      const icon = ok ? "✓" : "✗";
      const iconColor = ok ? theme.toolDone : theme.err;
      const lineCount = block.result ? block.result.split("\n").length : 0;

      if (!expanded) {
        return (
          <Box marginTop={1}>
            <Text>
              <Text color={iconColor}>{icon}</Text>
              <Text color={theme.tool} bold>
                {" " + block.name}
              </Text>
              <Text color={theme.dim2}> {preview}</Text>
              {lineCount > 0 ? <Text color={theme.dim}> · {lineCount} lines ▸</Text> : null}
            </Text>
          </Box>
        );
      }

      // Pre-wrapped to EXACTLY the width the estimator assumed, so the rendered height
      // can never disagree with the windowing calculation in logic.ts.
      const innerWidth = Math.max(1, width - CARD_PAD);
      const wrapped = wrapLines(block.result ?? "", innerWidth);
      const clipped = wrapped.length > MAX_CARD_LINES;
      const body = (clipped ? wrapped.slice(-MAX_CARD_LINES) : wrapped).join("\n");

      return (
        <Box
          flexDirection="column"
          marginTop={1}
          width={width}
          borderStyle="round"
          borderColor={ok ? theme.dim : theme.err}
          paddingX={1}
        >
          <Text>
            <Text color={iconColor}>{icon}</Text>
            <Text color={theme.tool} bold>
              {" " + block.name}
            </Text>
            <Text color={theme.dim2}> {preview}</Text>
          </Text>
          <Text color={theme.output} wrap="truncate-end">
            {body}
          </Text>
        </Box>
      );
    }
  }
});
