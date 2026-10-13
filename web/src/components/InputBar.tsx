import React, { useRef, useState, useEffect, useCallback } from "react";
import { matchCommands } from "../../../src/commands";
import { CommandMenu } from "./CommandMenu";

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px"; // grows with content — no cap, no internal scroll
}

const MAX_FILE_BYTES = 20 * 1024 * 1024; // mirrors config.ts's UPLOAD_MAX_BYTES

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

interface Pending {
  file: File;
  previewUrl?: string; // only set for images — revoked on removal/send to avoid leaking
}

export function InputBar({
  input,
  setInput,
  onSubmit,
  onCommand,
  running,
  onCancel,
}: {
  input: string;
  setInput: (s: string) => void;
  onSubmit: (text: string, files: File[]) => void;
  onCommand: (text: string) => void;
  running: boolean;
  onCancel: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Still composing the command name itself (no space yet) → the popup claims
  // up/down/tab/enter; past the first space those return to normal editing, same
  // split as tui/App.tsx so typing a command's arguments feels like normal typing.
  const menuMatches = input.startsWith("/") && !input.includes(" ") ? matchCommands(input) : [];
  useEffect(() => setCmdIndex(0), [input]);

  // Revoke every still-live object URL on unmount — nothing else owns these.
  useEffect(() => () => pending.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files);
    const tooBig = list.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) {
      setUploadError(`${tooBig.name} is over the ${fmtSize(MAX_FILE_BYTES)} limit`);
      return;
    }
    setUploadError(null);
    setPending((prev) => [
      ...prev,
      ...list.map((file) => ({ file, previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined })),
    ]);
  }, []);

  const removePending = useCallback((i: number) => {
    setPending((prev) => {
      prev[i]?.previewUrl && URL.revokeObjectURL(prev[i].previewUrl!);
      return prev.filter((_, idx) => idx !== i);
    });
  }, []);

  const send = () => {
    const t = input.trim();
    if (!t && pending.length === 0) return;
    if (t.startsWith("/")) {
      setInput("");
      onCommand(t);
      return;
    }
    setInput("");
    const files = pending.map((p) => p.file);
    pending.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    setPending([]);
    onSubmit(t, files);
    if (taRef.current) {
      taRef.current.style.height = "auto"; // collapse back down — clearing via state
      taRef.current.focus(); // doesn't fire the native input event autoGrow listens for
    }
  };

  const chooseCommand = (c: (typeof menuMatches)[number]) => {
    if (c.hint) {
      setInput(`/${c.name} `); // needs args — drop into the input, ready to type them
    } else {
      setInput("");
      onCommand(`/${c.name}`); // no args needed — just run it
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuMatches.length > 0) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCmdIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCmdIndex((i) => Math.min(menuMatches.length - 1, i + 1));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        chooseCommand(menuMatches[Math.min(cmdIndex, menuMatches.length - 1)]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(); // Enter always queues (even while running) — matches the TUI's semantics
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null);
    if (files.length) {
      e.preventDefault(); // this paste was an image/file, not text — don't also insert garbage
      addFiles(files);
    }
  };

  return (
    <div
      className={`input-bar-wrap ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      <CommandMenu matches={menuMatches} selected={cmdIndex} />
      {uploadError && <div className="upload-error">{uploadError}</div>}
      {pending.length > 0 && (
        <div className="attachment-chips">
          {pending.map((p, i) => (
            <div className="attachment-chip" key={i}>
              {p.previewUrl ? (
                <img className="chip-thumb" src={p.previewUrl} alt={p.file.name} />
              ) : (
                <span className="chip-icon">📎</span>
              )}
              <span className="chip-name">{p.file.name}</span>
              <span className="chip-size">{fmtSize(p.file.size)}</span>
              <button className="chip-remove" onClick={() => removePending(i)} title="Remove" aria-label="Remove attachment">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="input-bar">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = ""; // allow re-selecting the same file later
          }}
        />
        <button className="attach-btn" onClick={() => fileInputRef.current?.click()} title="Attach a file" aria-label="Attach a file">
          +
        </button>
        <textarea
          ref={taRef}
          className="input-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          onInput={(e) => autoGrow(e.currentTarget)}
        />
        {running ? (
          <button className="stop-btn" onClick={onCancel} title="Cancel the current turn">
            <span className="btn-icon">⏹</span>
            <span className="btn-label">stop</span>
          </button>
        ) : (
          <button className="send-btn" onClick={send} disabled={!input.trim() && pending.length === 0} title="Send">
            <span className="btn-icon">↵</span>
            <span className="btn-label">send</span>
          </button>
        )}
      </div>
    </div>
  );
}
