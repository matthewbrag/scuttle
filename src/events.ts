/** Events broadcast on a session's bus. Clients (CLI, PWA) subscribe to these. */
export type AgentEvent =
  | { type: "user"; content: string }
  /** One streamed chunk of the model's response — content and reasoning arrive as
   * separate fields (verified against llama-server: Qwen3 sends reasoning via its own
   * `reasoning_content` field, not <think> tags in content), so exactly one of these
   * is set per event. Used for both live token-by-token streaming and backlog replay. */
  | { type: "assistant_delta"; content?: string; reasoning?: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; result: string }
  /** show_image: the agent is displaying an image to the human (not feeding it back to
   * itself — that's view_image, a normal tool result). `url` is server-relative, already
   * pointing at /sessions/:id/files/..., so clients don't need to construct it themselves. */
  | { type: "image"; url: string; caption?: string }
  /** set_metric/clear_metric — the agent reporting on something it's tracking
   * (loss, throughput, whatever). `indicators` is the full current map (not a delta),
   * so a client that just replaces its local state on each event can't drift out of sync. */
  | { type: "indicators"; indicators: Record<string, { value: string; goal?: string; trend?: "up" | "down" }> }
  /** Per-turn model performance — straight from llama-server's own usage/timings, not
   * estimated. Fires once after each completed model call (one per agent-loop step). */
  | {
      type: "model_stats";
      promptTokens?: number;
      completionTokens?: number;
      cachedTokens?: number;
      ctxMax?: number;
      tokPerSec?: number;
      promptPerSec?: number;
      specAccept?: number;
      elapsedMs?: number;
      step?: number;
    }
  /** Container cpu/mem/gpu — polled per-CONNECTION (not the shared session event bus;
   * purely a live "right now" snapshot, nothing to persist or replay on reconnect). */
  | {
      type: "resources";
      cpuPercent?: number;
      memUsedMB?: number;
      memLimitMB?: number;
      gpuUtilPercent?: number;
      gpuMemUsedMB?: number;
      gpuMemTotalMB?: number;
    }
  /** Compaction's own summarize() call can take a real while on a big chunk of history —
   * without this, that whole stretch looks identical to a frozen UI (no streamed tokens,
   * no tool call, nothing) until "compacted" finally arrives. Fired right before the call
   * that will eventually emit "compacted" (or fail silently into the normal error path). */
  | { type: "compacting" }
  /** Context compaction ran — visible by default (not silent) so it's clear the agent's
   * memory of older messages is now a summary, not verbatim. `throughIndex` is how many
   * of the earliest messages are now covered by the summary instead of sent raw. */
  | { type: "compacted"; throughIndex: number }
  /** The model call failed in a way agent.ts knows how to recover from on its own (e.g. a
   * malformed tool-call JSON) and is retrying once — visible so it's clear why there's a
   * pause, not silent. */
  | { type: "retry"; reason: string }
  | { type: "cancelled" } // the current turn was interrupted via Ctrl+C
  | { type: "done" } // one turn finished
  | { type: "idle" } // queue drained; session is idle
  | { type: "status"; running: boolean } // sent on attach so a client knows current state
  | { type: "error"; message: string };
