/**
 * Carry session cookies across a browser restart.
 *
 * A cookie with no expiry is a *session* cookie: the site is saying "forget this
 * when the browser closes". A desktop browser honours that, and so does this one
 * - which is why `./orbit restart` or `down` signs you out of anything where you
 * did not tick "keep me signed in", while everything with a real expiry survives
 * on the profile volume as usual.
 *
 * That is correct behaviour and surprising behaviour at the same time: Orbit's
 * browser is a shared machine people leave logged in, and restarting the
 * container is an operator action, not a user closing their browser. So this
 * saves them on the way down and puts them back on the way up.
 *
 * OFF by default (`PERSIST_SESSION_COOKIES`), because it deliberately overrides
 * what the site asked for, and that is an operator's call rather than a default.
 *
 * At rest they are encrypted with a key derived from SESSION_SECRET: cookie
 * values are credentials, and Chromium keeps its own copies encrypted, so
 * writing them next door in plaintext would be a step down.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import { loadSessionCookies, saveSessionCookies } from '../db.js';
import type { CdpConnection } from './cdp.js';

/** Just enough of CDP's Network.Cookie to put one back. */
interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  session?: boolean;
  expires?: number;
  sourcePort?: number;
}

const key = () => scryptSync(config.sessionSecret, 'orbit-session-cookies', 32);

function seal(cookies: Cookie[]): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(cookies), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

function open(blob: string): Cookie[] {
  const [iv, tag, body] = blob.split('.');
  if (!iv || !tag || !body) return [];
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as Cookie[];
}

/**
 * Called while the browser is still alive, before it is asked to close.
 *
 * Session cookies only. Everything with an expiry is already Chromium's job and
 * copying it here would just be a second, staler copy of the same credential.
 */
export async function stashSessionCookies(cdp: CdpConnection): Promise<number> {
  if (!config.persistSessionCookies) return 0;
  try {
    const { cookies } = await cdp.send<{ cookies: Cookie[] }>('Storage.getCookies', {}, undefined, 5000);
    const session = cookies.filter((c) => c.session === true || c.expires === -1);
    saveSessionCookies(session.length ? seal(session) : null);
    // Count only - never the names, domains or values. See docs/security.md.
    log.info('session cookies stashed for the next start', { count: session.length });
    return session.length;
  } catch (err) {
    log.warn('could not stash session cookies', { err: err as Error });
    return 0;
  }
}

/**
 * Called on a fresh connection, before tabs are restored - so a page that is
 * about to load already has them.
 */
export async function restoreSessionCookies(cdp: CdpConnection): Promise<number> {
  if (!config.persistSessionCookies) return 0;
  const blob = loadSessionCookies();
  if (!blob) return 0;
  try {
    const cookies = open(blob).map((c) => ({ ...c, expires: undefined, session: true }));
    if (!cookies.length) return 0;
    await cdp.send('Storage.setCookies', { cookies }, undefined, 10_000);
    log.info('session cookies restored', { count: cookies.length });
    return cookies.length;
  } catch (err) {
    // A changed SESSION_SECRET makes the stash undecryptable, which is the same
    // as not having one: drop it rather than failing every start from here on.
    log.warn('could not restore session cookies - discarding the stash', { err: err as Error });
    saveSessionCookies(null);
    return 0;
  }
}

export const __test = { seal, open };
