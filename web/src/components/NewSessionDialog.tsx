import React, { useState, useEffect, useCallback, useRef } from "react";
import * as api from "../api";
import type { BrowseEntry } from "../api";

export function NewSessionDialog({
  open,
  initialPath,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  initialPath?: string;
  onCancel: () => void;
  onConfirm: (path: string) => Promise<void>;
}) {
  const [path, setPath] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const newFolderRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (target?: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.browseDir(target);
      setPath(r.path);
      setPathInput(r.path);
      setParent(r.parent);
      setEntries(r.entries);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setCreatingFolder(false);
      setNewFolderName("");
      setSubmitting(false);
      void load(initialPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (creatingFolder) newFolderRef.current?.focus();
  }, [creatingFolder]);

  if (!open) return null;

  const confirm = async () => {
    if (submitting) return; // already creating one — a second click must not fire another
    setSubmitting(true);
    try {
      await onConfirm(path);
      // On success the parent closes the dialog (open becomes false); nothing to reset here.
    } catch {
      setSubmitting(false); // failed — let them try again
    }
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await api.makeDir(path, name);
      setNewFolderName("");
      setCreatingFolder(false);
      void load(path);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={submitting ? undefined : onCancel}>
      <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">New session — choose a project folder</div>
        <div className="dialog-pathbar">
          <button className="dialog-up-btn" onClick={() => parent && load(parent)} disabled={!parent} title="Up a level" aria-label="Up a level">
            ↑
          </button>
          <input
            className="dialog-path-input"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") load(pathInput);
            }}
          />
        </div>
        <div className="dialog-list">
          {loading && <div className="dialog-empty">loading…</div>}
          {!loading && error && <div className="dialog-error">{error}</div>}
          {!loading && !error && entries.length === 0 && <div className="dialog-empty">(no subfolders)</div>}
          {!loading &&
            !error &&
            entries.map((e) => (
              <div key={e.name} className="dialog-entry" onClick={() => load(`${path}/${e.name}`)}>
                📁 {e.name}
              </div>
            ))}
        </div>
        <div className="dialog-footer">
          {creatingFolder ? (
            <div className="dialog-newfolder">
              <input
                ref={newFolderRef}
                className="dialog-newfolder-input"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createFolder();
                  if (e.key === "Escape") setCreatingFolder(false);
                }}
                placeholder="folder name"
              />
              <button className="dialog-secondary-btn" onClick={createFolder}>
                Create
              </button>
              <button className="dialog-secondary-btn" onClick={() => setCreatingFolder(false)}>
                ✕
              </button>
            </div>
          ) : (
            <button className="dialog-secondary-btn" onClick={() => setCreatingFolder(true)}>
              + New folder
            </button>
          )}
          <div className="dialog-footer-actions">
            <button className="dialog-cancel-btn" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
            <button className="dialog-confirm-btn" disabled={!path || loading || submitting} onClick={confirm}>
              {submitting ? "Creating…" : "Use this folder"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
