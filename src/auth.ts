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

// In-memory on purpose — resets on server restart (back to a login prompt), which is a
// fine tradeoff for a single-user tool restarted this often during development; nothing
// about the design stops adding persistence later if that stops being true.
const validTokens = new Set<string>();

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
  if (validTokens.has(cookies[COOKIE_NAME])) return next();
  if (checkBasicAuth(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}

export function login(req: Request, res: Response) {
  const password = req.body?.password;
  if (password !== getOrCreatePassword()) {
    return res.status(401).json({ error: "wrong password" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  validTokens.add(token);
  // Not `secure: true` — this same app is also used over plain http://127.0.0.1 locally
  // (TUI's co-located server, direct desktop access), and a Secure cookie is silently
  // dropped by the browser over a non-HTTPS connection, breaking exactly that case.
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 30 });
  res.json({ ok: true });
}

export function logout(req: Request, res: Response) {
  const cookies = parseCookies(req.headers.cookie);
  validTokens.delete(cookies[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
}

export { USERNAME as AUTH_USERNAME, PASSWORD_PATH };
