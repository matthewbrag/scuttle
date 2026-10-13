import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "./config";

/**
 * Lightweight sidecar recording which files a user attached to which message, purely so
 * a reconnecting client can rebuild the same display (caption + "📎 name" notes + inline
 * image blocks) the live path showed, without re-deriving it from the persisted message's
 * content parts — those mix the caption with whatever got inlined for the MODEL (a full
 * text-file dump, or a base64 image body), which is not what a human should see re-shown
 * in the chat bubble on reconnect. Images additionally avoid re-shipping their (often
 * multi-MB) base64 over SSE by reusing the cheap `/sessions/:id/files/*` route instead —
 * the same trick show_image's replay already does from its own tool_call arguments.
 */
export interface AttachmentRecord {
  /** 0-indexed position among user-role messages — lets replay match a record back to
   * the right point in the transcript without needing the message content itself. */
  userMessageSeq: number;
  relPath: string;
  name: string;
  mime: string;
}

const attachmentsPath = (sessionId: string) => path.join(SESSIONS_DIR, sessionId, "attachments.json");

export function recordAttachments(sessionId: string, records: AttachmentRecord[]) {
  if (!records.length) return;
  const f = attachmentsPath(sessionId);
  const existing = readAttachments(sessionId);
  fs.writeFileSync(f, JSON.stringify([...existing, ...records]));
}

export function readAttachments(sessionId: string): AttachmentRecord[] {
  const f = attachmentsPath(sessionId);
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, "utf8"));
}
