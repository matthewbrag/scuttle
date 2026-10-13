import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Filesystem browsing for the "new session" project-picker dialog — lets the PWA show a
 * folder tree instead of making the user type an absolute path blind. Read-only (names
 * only, never file contents) and sits behind the same basic auth as every other route, so
 * it exposes nothing beyond what create-session already allowed (an arbitrary typed path)
 * — just friendlier to navigate. */

export interface BrowseEntry {
  name: string;
  isDir: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

const HOME = os.homedir();

function isDirSafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false; // broken symlink or permission denied — just skip it
  }
}

export function browseDir(target?: string): BrowseResult {
  const dir = path.resolve(target && target.trim() ? target : HOME);
  const stat = fs.statSync(dir); // throws (caller returns 400) if missing/unreadable
  if (!stat.isDirectory()) throw new Error("not a directory");

  const entries: BrowseEntry[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith(".")) continue; // hide dotfiles/dirs — less noise picking a project root
    const full = path.join(dir, d.name);
    if (d.isDirectory() || (d.isSymbolicLink() && isDirSafe(full))) entries.push({ name: d.name, isDir: true });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const root = path.parse(dir).root;
  return { path: dir, parent: dir === root ? null : path.dirname(dir), entries };
}

export function makeDir(target: string, name: string): string {
  const safeName = name.trim();
  if (!safeName || safeName.includes("/") || safeName.includes("\\") || safeName === "." || safeName === "..") {
    throw new Error("invalid folder name");
  }
  const dir = path.resolve(target);
  if (!fs.statSync(dir).isDirectory()) throw new Error("not a directory");
  const newPath = path.join(dir, safeName);
  if (fs.existsSync(newPath)) throw new Error("already exists");
  fs.mkdirSync(newPath);
  return newPath;
}
