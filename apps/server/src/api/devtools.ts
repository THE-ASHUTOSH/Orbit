/**
 * Chrome DevTools, proxied through this server's authentication.
 *
 * This is the one place where a raw CDP channel reaches a client, so the shape
 * of it matters:
 *
 *   - OFF by default (DEVTOOLS_ENABLED). A deployment that does not want it has
 *     no path to it at all.
 *   - Admins only. A user with control over a tab can send input; DevTools can
 *     run arbitrary JavaScript and read that page's cookies, which is a large
 *     escalation.
 *   - PAGE-scoped, never the browser endpoint. Attaching to
 *     /devtools/page/<targetId> means no Target.*, no Browser.close, no
 *     Storage.getCookies across every origin - only the one page.
 *   - Audited. Every open is written to audit_events with who and which tab.
 *
 * Chromium's DevTools port still never leaves loopback: this server is the only
 * thing that talks to it, exactly as before. What changes is that an
 * authenticated admin can now borrow that channel for one page.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config.js';
import { log } from '../log.js';
import { audit } from '../db.js';
import { sessionFromRequest } from '../auth/session.js';
import { isOriginAllowed } from './origin.js';
import type { Runtime } from '../runtime.js';

/** Frontend assets are only ever fetched from Chromium's own loopback server. */
const FRONTEND_PREFIX = '/devtools/';
export const DEVTOOLS_WS_PREFIX = '/devtools-ws/';

export function mountDevtools(
  app: Express,
  rt: Runtime,
  authed: (req: Request, res: Response, next: NextFunction) => void,
  adminOnly: (req: Request, res: Response, next: NextFunction) => void,
): void {
  /**
   * Where to send an admin to inspect a tab. Returned by the API rather than
   * built in the client so the client never needs to know about target ids or
   * the CDP port.
   */
  app.get('/api/tabs/:tabId/devtools', authed, adminOnly, (req, res) => {
    if (!config.devtoolsEnabled) return res.status(404).json({ error: 'disabled' });
    const tabId = req.params.tabId ?? '';
    const tab = rt.tabs.get(tabId);
    if (!tab) return res.status(404).json({ error: 'tab_not_found' });

    audit('devtools.open', { userId: req.user!.id, tabId, detail: { targetId: tab.targetId } });
    log.warn('devtools session opened', { userId: req.user!.id, tabId, targetId: tab.targetId });

    // DevTools takes the CDP socket as a host-relative address and reuses the
    // page's own scheme, so this works over http and https alike.
    const host = req.headers.host ?? `127.0.0.1:${config.port}`;
    const ws = `${host}${DEVTOOLS_WS_PREFIX}${tab.targetId}`;
    res.json({
      url: `/devtools/inspector.html?ws=${encodeURIComponent(ws)}`,
      targetId: tab.targetId,
    });
  });

  /**
   * Serve Chromium's bundled DevTools frontend. Proxied rather than vendored so
   * the frontend always matches the browser version it is debugging.
   */
  app.get(/^\/devtools\/.*/, authed, adminOnly, (req, res) => {
    if (!config.devtoolsEnabled) return res.status(404).json({ error: 'disabled' });
    const base = rt.browser.cdpHttpBase;
    if (!base) return res.status(503).json({ error: 'browser_unavailable' });

    const target = `${base}${req.path}${req.url.slice(req.path.length)}`;
    void fetch(target, { signal: AbortSignal.timeout(10_000) })
      .then(async (upstream) => {
        res.status(upstream.status);
        const type = upstream.headers.get('content-type');
        if (type) res.setHeader('Content-Type', type);
        // The app's CSP forbids inline scripts, which the DevTools frontend
        // relies on. Give this document its own policy instead of loosening the
        // application's: it may only talk to this origin.
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self' ws: wss:; img-src 'self' data: blob:",
        );
        res.setHeader('Cache-Control', 'no-store');
        res.removeHeader('X-Frame-Options');
        res.end(Buffer.from(await upstream.arrayBuffer()));
      })
      .catch((err) => {
        log.warn('devtools frontend proxy failed', { path: req.path, err: err as Error });
        if (!res.headersSent) res.status(502).json({ error: 'devtools_unavailable' });
      });
  });
}

/**
 * Pipe a client WebSocket to one page's CDP socket.
 *
 * Returns true when it handled the upgrade. Authentication happens here, before
 * a single byte reaches Chromium.
 */
export function handleDevtoolsUpgrade(rt: Runtime, req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  if (!req.url?.startsWith(DEVTOOLS_WS_PREFIX)) return false;

  const deny = (code: number, why: string) => {
    log.warn('devtools upgrade rejected', { why, ip: req.socket.remoteAddress });
    socket.write(`HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return true;
  };

  if (!config.devtoolsEnabled) return deny(403, 'devtools disabled');
  if (!isOriginAllowed(req.headers.origin, req.headers.host)) return deny(403, 'origin not allowed');
  const session = sessionFromRequest(req);
  if (!session) return deny(401, 'no valid session');
  if (session.user.role !== 'admin') return deny(403, 'not an admin');

  const targetId = req.url.slice(DEVTOOLS_WS_PREFIX.length).split('?')[0] ?? '';
  // Only ids that belong to a tab this server is tracking, so the parameter
  // cannot be used to reach some other target.
  const tab = rt.tabs.list().find((t) => t.targetId === targetId);
  if (!tab) return deny(403, 'unknown target');

  const base = rt.browser.cdpHttpBase;
  if (!base) return deny(403, 'browser unavailable');
  const upstreamUrl = `${base.replace('http://', 'ws://')}/devtools/page/${targetId}`;

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  wss.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(upstreamUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    const clog = log.child({ userId: session.user.id, tabId: tab.tabId });
    clog.info('devtools attached', { targetId });

    const close = () => {
      try {
        client.close();
      } catch {
        /* already closed */
      }
      try {
        upstream.close();
      } catch {
        /* already closed */
      }
    };

    // Straight pipe in both directions. Nothing is inspected or rewritten: this
    // is a channel, and the authorization decision was made above.
    //
    // The `binary` flag has to be carried across. ws delivers a Buffer for text
    // frames too, so forwarding it without the flag re-sends CDP's JSON as a
    // binary frame - which Chromium answers by dropping the connection.
    const queued: { data: Buffer; binary: boolean }[] = [];
    client.on('message', (data, isBinary) => {
      const frame = { data: data as Buffer, binary: isBinary };
      if (upstream.readyState === WebSocket.OPEN) upstream.send(frame.data, { binary: frame.binary });
      else queued.push(frame);
    });
    upstream.on('open', () => {
      for (const frame of queued.splice(0)) upstream.send(frame.data, { binary: frame.binary });
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data as Buffer, { binary: isBinary });
    });
    upstream.on('error', (err) => {
      clog.warn('devtools upstream error', { err, upstreamUrl });
      close();
    });
    // A non-101 reply from Chromium arrives as 'unexpected-response', not
    // 'error'; without this the failure shows up only as a bare 1006 close.
    upstream.on('unexpected-response', (_req, res) => {
      clog.warn('devtools upstream refused the upgrade', {
        status: res.statusCode,
        statusMessage: res.statusMessage,
        upstreamUrl,
      });
      close();
    });
    client.on('error', (err) => {
      clog.warn('devtools client error', { err });
      close();
    });
    client.on('close', (code, reason) => {
      clog.info('devtools detached', { targetId, side: 'client', code, reason: reason?.toString().slice(0, 80) });
      close();
    });
    upstream.on('close', (code, reason) => {
      clog.info('devtools upstream closed', { code, reason: reason?.toString().slice(0, 80) });
      close();
    });
  });
  return true;
}
