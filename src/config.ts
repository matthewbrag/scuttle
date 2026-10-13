import os from "node:os";
import path from "node:path";

/** The single pointer to all Scuttle state. */
export const SCUTTLE_HOME = process.env.SCUTTLE_HOME || path.join(os.homedir(), ".scuttle");
export const SESSIONS_DIR = path.join(SCUTTLE_HOME, "sessions");

/**
 * Shared cache mounted into every session at /root/.cache (pip, HF hub, ...).
 * Defaults to a Scuttle-managed dir so root-owned container writes don't pollute
 * the user's real ~/.cache. Point SCUTTLE_CACHE_DIR at ~/.cache to share host-wide.
 */
export const CACHE_DIR = process.env.SCUTTLE_CACHE_DIR || path.join(SCUTTLE_HOME, "cache");

/** Model provider (OpenAI-compatible, local-first). */
export const MODEL_BASE_URL = process.env.SCUTTLE_MODEL_URL || "http://localhost:8080/v1";
export const MODEL_NAME = process.env.SCUTTLE_MODEL || "local";
export const MODEL_API_KEY = process.env.SCUTTLE_API_KEY || "sk-local";

/** Per-session sandbox image + default GPU. This rig runs the model on 0/2, so 1 is free. */
export const RUNTIME_IMAGE = process.env.SCUTTLE_IMAGE || "scuttle-runtime";
export const DEFAULT_GPU = process.env.SCUTTLE_GPU || "1";

export const SERVER_PORT = Number(process.env.SCUTTLE_PORT || 4177);
export const MAX_STEPS = Number(process.env.SCUTTLE_MAX_STEPS || 25);

/** Compact the conversation once prompt_tokens crosses this fraction of ctxMax. */
export const COMPACTION_THRESHOLD = Number(process.env.SCUTTLE_COMPACTION_THRESHOLD || 0.85);
/** Most recent N messages always kept verbatim (never summarized away). */
export const COMPACTION_KEEP_RECENT = Number(process.env.SCUTTLE_COMPACTION_KEEP_RECENT || 12);

/** Upload dock (PWA): per-file cap, and how large a text-ish file can be before it's
 * left on disk for the agent to read itself instead of being inlined whole. */
export const UPLOAD_MAX_BYTES = Number(process.env.SCUTTLE_UPLOAD_MAX_BYTES || 20 * 1024 * 1024);
export const ATTACHMENT_TEXT_INLINE_MAX_BYTES = Number(process.env.SCUTTLE_ATTACHMENT_TEXT_INLINE_MAX_BYTES || 100 * 1024);

/** Cap on a single run_bash/check_background result handed back to the model. Was
 * hardcoded at 20_000 chars (~5k tokens) with no signal when it clipped — on a 196k-token
 * model that forced reading any real-sized file in dozens of blind, context-costly
 * round trips, and worse, the model had no way to know it was even happening. Raised to
 * a much more generous share of a typical context window; truncation (when it still
 * happens) is now announced in the result text instead of silent. */
export const TOOL_OUTPUT_MAX_CHARS = Number(process.env.SCUTTLE_TOOL_OUTPUT_MAX_CHARS || 100_000);
