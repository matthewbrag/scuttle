import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { SCUTTLE_HOME } from "./config";

/**
 * Auth for exposing the server beyond localhost (tailnet, etc.). Two paths, both
 * checked by `requireAuth`:
 *  - A `scuttle_token` cookie, issued by POST /login — what the PWA uses. Cookie-based
 *    (not a header the PWA attaches manually) specifically because it rides along for
 *    free on <img src> and EventSource requests, neither of which can carry custom
 *    headers — the same mechanism covers fetch, images, and the live stream with zero
 *    PWA client code needing to know about auth at all.
 *  - A raw `Authorization: Basic` header — what the TUI/CLI already send on every
 *    request (see tui/api.ts, cli.ts), unchanged by any of this.
 * Deliberately does NOT send `WWW-Authenticate` on a 401 — that header is what makes
 * the BROWSER pop its own native basic-auth dialog, which is exactly the opaque,
 * no-visible-error prompt this login page replaces.
 */
const USERNAME = "scuttle";
const PASSWORD_PATH = path.join(SCUTTLE_HOME, "server-password");
const COOKIE_NAME = "scuttle_token";

export function getOrCreatePassword(): string {
  try {
    const existing = fs.readFileSync(PASSWORD_PATH, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* doesn't exist yet */
  }
  fs.mkdirSync(SCUTTLE_HOME, { recursive: true });
  const pw = crypto.randomBytes(18).toString("base64").replace(/[/+=]/g, "");
  fs.writeFileSync(PASSWORD_PATH, pw, { mode: 0o600 });
  return pw;
}

// Persisted to disk — an in-memory token store meant a login survived only until the
// NEXT server restart, silently signing out anyone with the tab already open (it still
// LOOKS logged in until the next request 401s, which reads exactly like stale/broken
// state). Restarts turned out to be far more frequent in practice than "fine tradeoff"
// assumed — every single deploy during active development counts. Pruned to the same
// 30-day window as the cookie's own maxAge, so this can't grow unbounded.
interface StoredToken {
  token: string;
  createdAt: number;
}
const TOKENS_PATH = path.join(SCUTTLE_HOME, "auth-tokens.json");
const TOKEN_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

function loadTokens(): StoredToken[] {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")) as StoredToken[];
    const now = Date.now();
    return raw.filter((t) => now - t.createdAt < TOKEN_MAX_AGE_MS);
  } catch {
    return [];
  }
}

function saveTokens() {
  fs.mkdirSync(SCUTTLE_HOME, { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(validTokens), { mode: 0o600 });
}

let validTokens: StoredToken[] = loadTokens();

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function checkBasicAuth(req: Request): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const [user, pass] = Buffer.from(header.slice(6), "base64").toString().split(":");
  return user === USERNAME && pass === getOrCreatePassword();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const cookies = parseCookies(req.headers.cookie);
  if (validTokens.some((t) => t.token === cookies[COOKIE_NAME])) return next();
  if (checkBasicAuth(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}

export function login(req: Request, res: Response) {
  const password = req.body?.password;
  if (password !== getOrCreatePassword()) {
    return res.status(401).json({ error: "wrong password" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  validTokens.push({ token, createdAt: Date.now() });
  saveTokens();
  // Not `secure: true` — this same app is also used over plain http://127.0.0.1 locally
  // (TUI's co-located server, direct desktop access), and a Secure cookie is silently
  // dropped by the browser over a non-HTTPS connection, breaking exactly that case.
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", maxAge: TOKEN_MAX_AGE_MS });
  res.json({ ok: true });
}

export function logout(req: Request, res: Response) {
  const cookies = parseCookies(req.headers.cookie);
  validTokens = validTokens.filter((t) => t.token !== cookies[COOKIE_NAME]);
  saveTokens();
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
}

export { USERNAME as AUTH_USERNAME, PASSWORD_PATH };
