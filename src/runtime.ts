import { EventEmitter } from "node:events";
import { runTurn, type UserInput } from "./agent";
import type { AgentEvent } from "./events";

/**
 * Server-owned execution for a session. The run loop lives here, decoupled from
 * any client connection — turns keep running when the CLI/phone detaches, and
 * multiple clients can subscribe to the same live stream. This is what makes
 * "leave it unsupervised, check back from your phone" actually work.
 */
interface Runtime {
  emitter: EventEmitter;
  running: boolean;
  queue: UserInput[];
  /** Aborts only the CURRENT turn (model call + any in-flight tool exec) — not the
   * rest of the queue, so "Ctrl+C cancels, Enter always queues" stay independent:
   * a cancel just skips ahead to whatever's queued next, exactly like a normal
   * turn finishing. Set fresh per-turn in drain(), cleared once that turn ends. */
  abort: AbortController | null;
}

const runtimes = new Map<string, Runtime>();

function get(sessionId: string): Runtime {
  let r = runtimes.get(sessionId);
  if (!r) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    r = { emitter, running: false, queue: [], abort: null };
    runtimes.set(sessionId, r);
  }
  return r;
}

export function subscribe(sessionId: string, cb: (e: AgentEvent) => void): () => void {
  const r = get(sessionId);
  r.emitter.on("event", cb);
  return () => r.emitter.off("event", cb);
}

export function isRunning(sessionId: string): boolean {
  return get(sessionId).running;
}

/** Push an event into a session's live bus from outside the turn loop — e.g. manual
 * /compact, which can run regardless of whether a turn is currently in flight (it just
 * reads history and calls the model once; the NEXT model call, in this turn or the
 * next, rebuilds its prompt fresh from disk and picks up the new checkpoint naturally). */
export function emitEvent(sessionId: string, e: AgentEvent) {
  get(sessionId).emitter.emit("event", e);
}

/** Enqueue a user message; runs immediately if idle, otherwise after the current turn. */
export function submit(sessionId: string, input: UserInput) {
  const r = get(sessionId);
  r.queue.push(input);
  void drain(sessionId);
}

/** Interrupt the in-flight turn, if any. Returns false if nothing was running. */
export function cancel(sessionId: string): boolean {
  const r = get(sessionId);
  if (!r.running || !r.abort) return false;
  r.abort.abort();
  return true;
}

async function drain(sessionId: string) {
  const r = get(sessionId);
  if (r.running) return;
  r.running = true;
  const emit = (e: AgentEvent) => r.emitter.emit("event", e);
  try {
    while (r.queue.length) {
      const input = r.queue.shift()!;
      // Images show as their own inline block right below (see agent.ts's "image" emit);
      // a non-image attachment gets a short note on the user's own bubble instead, since
      // there's no separate block kind for "here's a file" the way there is for images.
      const fileNotes = (input.attachments ?? [])
        .filter((a) => !a.mime.startsWith("image/"))
        .map((a) => `📎 ${a.name}`);
      const display = [input.text.trim(), ...fileNotes].filter(Boolean).join("\n");
      emit({ type: "user", content: display });
      r.abort = new AbortController();
      try {
        await runTurn(sessionId, input, emit, r.abort.signal);
      } finally {
        r.abort = null;
      }
    }
  } finally {
    r.running = false;
    emit({ type: "idle" });
  }
}
