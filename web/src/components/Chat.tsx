import React, { useRef, useEffect } from "react";
import type { Block } from "../../../src/tui/logic";
import { MessageBlock } from "./MessageBlock";

const PINNED_THRESHOLD = 48; // px from bottom still counts as "at the bottom"

export function Chat({ blocks }: { blocks: Block[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true); // auto-follow the latest unless the user scrolls up

  useEffect(() => {
    const el = containerRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_THRESHOLD;
  };

  return (
    <div className="chat-scroll" ref={containerRef} onScroll={onScroll}>
      {blocks.length === 0 ? (
        <div className="chat-empty">ask scuttle to build, debug, or run anything…</div>
      ) : (
        blocks.map((b, i) => <MessageBlock key={i} block={b} />)
      )}
    </div>
  );
}
