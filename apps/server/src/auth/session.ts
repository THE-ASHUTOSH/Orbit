/**
 * Session cookies: an opaque server-side session id plus an HMAC so a forged or
 * tampered cookie is rejected without a database round-trip.
 *
 * The cookie is the only client-supplied identity input. WebSocket upgrades are
 * authenticated from the same cookie - the client never sends a userId.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { config } from '../config.js';
import { getSession, extendSession, type UserRow } from '../db.js';

export const COOKIE_NAME = 'cb_session';

const sign = (value: string) =>
  createHmac('sha256', config.sessionSecret).update(value).digest('base64url');

export function makeCookieValue(sessionId: string): string {
  return `${sessionId}.${sign(sessionId)}`;
}

export function readCookieValue(raw: string | undefined): string | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const sessionId = raw.slice(0, dot);
  const mac = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(sessionId));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  return sessionId;
}

export function serializeCookie(sessionId: string | null): string {
  const attrs = [
    `Path=/`,
    `HttpOnly`,
    // Lax (not Strict) so following a LAN link into the app keeps the session.
    `SameSite=Lax`,
    config.secureCookies ? 'Secure' : '',
  ].filter(Boolean);
  if (sessionId === null) return [`${COOKIE_NAME}=`, ...attrs, 'Max-Age=0'].join('; ');
  return [
    `${COOKIE_NAME}=${makeCookieValue(sessionId)}`,
    ...attrs,
    `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`,
  ].join('; ');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export interface AuthedSession {
  sessionId: string;
  user: UserRow;
}

/** Resolves the session for any http/ws request, or null when unauthenticated. */
export function sessionFromRequest(req: IncomingMessage): AuthedSession | null {
  const sessionId = readCookieValue(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  if (!sessionId) return null;
  const row = getSession(sessionId);
  if (!row) return null;
  // Sliding window: refresh when less than half the TTL remains.
  if (row.expires_at - Date.now() < config.sessionTtlMs / 2) extendSession(sessionId);
  return { sessionId, user: row.user };
}
