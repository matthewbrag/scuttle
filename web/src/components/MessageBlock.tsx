import React, { useState } from "react";
import { argsPreview, parseInline, parseBlocks, toolOk, type Block, type Span } from "../../../src/tui/logic";
import { highlight } from "../prism";

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.code ? (
          <code key={i}>{s.text}</code>
        ) : s.bold ? (
          <b key={i}>{s.text}</b>
        ) : s.italic ? (
          <i key={i}>{s.text}</i>
        ) : (
          <React.Fragment key={i}>{s.text}</React.Fragment>
        ),
      )}
    </>
  );
}

/** Headings render at h4–h6 (never h1–h3) — a `#` from the model shouldn't blow up to
 * page-title size inside a chat bubble. */
function MarkdownBody({ text }: { text: string }) {
  return (
    <>
      {parseBlocks(text).map((b, i) => {
        if (b.kind === "code") {
          const code = b.lines.join("\n");
          // Prism escapes the code itself before wrapping tokens in spans — safe to
          // inject even though the text ultimately comes from model output, same as
          // any syntax highlighter's normal escape-then-tokenize contract.
          return (
            <pre className="md-code" key={i}>
              {b.lang && <div className="md-code-lang">{b.lang}</div>}
              <code dangerouslySetInnerHTML={{ __html: highlight(code, b.lang) }} />
            </pre>
          );
        }
        if (b.kind === "heading") {
          const Tag = `h${Math.min(b.level + 3, 6)}` as keyof JSX.IntrinsicElements;
          return (
            <Tag className="md-heading" key={i}>
              <Spans spans={b.spans} />
            </Tag>
          );
        }
        if (b.kind === "list") {
          const ListTag = (b.ordered ? "ol" : "ul") as keyof JSX.IntrinsicElements;
          return (
            <ListTag className="md-list" key={i}>
              {b.items.map((spans, j) => (
                <li key={j}>
                  <Spans spans={spans} />
                </li>
              ))}
            </ListTag>
          );
        }
        return (
          <p className="md-para" key={i}>
            <Spans spans={b.spans} />
          </p>
        );
      })}
    </>
  );
}

function Turn({ role, cls, text }: { role: string; cls: string; text: string }) {
  return (
    <div className={`turn ${cls}`}>
      <div className="turn-role">{role}</div>
      <div className="turn-body">
        <MarkdownBody text={text} />
      </div>
    </div>
  );
}

export function MessageBlock({ block }: { block: Block }) {
  const [expanded, setExpanded] = useState(false);

  switch (block.kind) {
    case "user":
      return <Turn role="▌ YOU" cls={`user ${block.pending ? "pending" : ""}`} text={block.text} />;
    case "assistant":
      return <Turn role="✦ SCUTTLE" cls="assistant" text={block.text} />;
    case "error":
      return <Turn role="✖ ERROR" cls="error" text={block.text} />;
    case "info":
      return (
        <div className="info-block">
          <Spans spans={parseInline(block.text)} />
        </div>
      );
    case "image":
      return (
        <div className="image-block">
          <img src={block.url} alt={block.caption || block.url} loading="lazy" />
          {block.caption && <div className="image-caption">{block.caption}</div>}
        </div>
      );
    case "thinking": {
      const lines = block.text.split("\n").length;
      return (
        <div className="thinking-block" onClick={() => setExpanded((x) => !x)}>
          <div className="thinking-label">
            ◇ thinking {expanded ? "▾" : `(${lines} ${lines === 1 ? "line" : "lines"}) ▸`}
          </div>
          {expanded && <div className="thinking-body">{block.text}</div>}
        </div>
      );
    }
    case "tool": {
      const preview = argsPreview(block.args);
      if (block.running) {
        return (
          <div className="tool-block running">
            <span className="spinner" />
            <span className="tool-name">{block.name}</span>
            <span className="tool-preview">{preview}</span>
            <span className="dim"> …</span>
          </div>
        );
      }
      const ok = toolOk(block.result);
      const lineCount = block.result ? block.result.split("\n").length : 0;
      return (
        <div className={`tool-block ${ok ? "ok" : "fail"} ${expanded ? "expanded" : ""}`} onClick={() => setExpanded((x) => !x)}>
          <div className="tool-header">
            <span className="tool-icon">{ok ? "✓" : "✗"}</span>
            <span className="tool-name">{block.name}</span>
            <span className="tool-preview">{preview}</span>
            {lineCount > 0 && <span className="dim"> · {lineCount} lines {expanded ? "▾" : "▸"}</span>}
          </div>
          {expanded && <pre className="tool-output">{block.result}</pre>}
        </div>
      );
    }
  }
}
