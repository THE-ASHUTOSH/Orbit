/**
 * Origin checks.
 *
 * Browsers do not apply same-origin to WebSockets and send cookies with
 * cross-site GETs, so a malicious page on the LAN could otherwise drive the
 * shared browser through a victim's session. Default policy: same host, or any
 * private-range/localhost/.local origin (this is a LAN product), plus whatever
 * TRUSTED_ORIGINS names for Internet mode.
 */
import { config } from '../config.js';

const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)$/i;

export function isOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
  // No Origin header: a non-browser client (curl, the benchmark harness, a
  // native app). CSRF needs a browser, so there is nothing to forge here.
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (config.trustedOrigins.includes(origin)) return true;
  if (host && parsed.host === host) return true;
  return PRIVATE_HOST.test(parsed.hostname);
}
