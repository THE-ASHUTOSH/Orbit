/**
 * REST surface. Deliberately small: login/logout, state for the initial page
 * load, admin operations, and the file transfer endpoints. Everything
 * interactive goes over the WebSocket.
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import {
  createReadStream,
  readdirSync,
  statSync,
  createWriteStream,
  existsSync,
  unlinkSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { Role, TabPermission } from '@orbit/protocol';
import { config } from '../config.js';
import { log } from '../log.js';
import { id } from '../ids.js';
import {
  audit,
  authenticate,
  createSession,
  createUser,
  deleteSession,
  deleteUser,
  deleteUserSessions,
  getUserByName,
  grantTab,
  listTabGrants,
  listUsers,
  recentAudit,
  addBookmark,
  listBookmarks,
  removeBookmark,
  recentHistory,
  searchHistory,
  searchBookmarks,
  clearHistory,
  revokeTab,
  setUserPassword,
  setUserRole,
  touchUser,
  type UserRow,
} from '../db.js';
import { COOKIE_NAME, serializeCookie, sessionFromRequest } from '../auth/session.js';
import { roleCan } from '../auth/permissions.js';
import { isOriginAllowed } from './origin.js';
import { listExtensions, removeExtension, downloadFromWebStore, parseStoreId } from '../browser/extensions.js';
import { normalizeUrl } from '../browser/TabManager.js';
import { mountDevtools } from './devtools.js';
import type { Runtime } from '../runtime.js';
import type { Hub } from '../ws/hub.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
      sessionId?: string;
      requestId?: string;
    }
  }
}

/** Login attempts per IP: slow down credential stuffing on an exposed port. */
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX = 10;

function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > LOGIN_MAX;
}

export function buildApp(rt: Runtime, hub: () => Hub): Express {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));

  // --- cross-cutting -------------------------------------------------------

  app.use((req, res, next) => {
    req.requestId = id('req');
    res.setHeader('X-Request-Id', req.requestId);
    // Conservative headers. The app is same-origin only: no third-party frames,
    // no external scripts, and the frame stream is a WebSocket, not an <iframe>.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; " +
        "script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  // State-changing requests must come from an allowed Origin: the session
  // cookie alone is not proof the user meant to make this request.
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!isOriginAllowed(req.headers.origin, req.headers.host))
      return res.status(403).json({ error: 'origin_not_allowed' });
    next();
  });

  const authed = (req: Request, res: Response, next: NextFunction) => {
    const session = sessionFromRequest(req);
    if (!session) return res.status(401).json({ error: 'unauthorized' });
    req.user = session.user;
    req.sessionId = session.sessionId;
    next();
  };

  const adminOnly = (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    next();
  };

  // --- auth ----------------------------------------------------------------

  const Credentials = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });

  app.post('/api/auth/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (loginRateLimited(ip)) {
      log.warn('login rate limited', { ip });
      return res.status(429).json({ error: 'too_many_attempts' });
    }
    const parsed = Credentials.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
    const user = authenticate(parsed.data.username, parsed.data.password);
    if (!user) {
      log.warn('failed login', { username: parsed.data.username.slice(0, 40), ip });
      audit('auth.login.failed', { detail: { username: parsed.data.username.slice(0, 40) } });
      // Same message for unknown user and wrong password.
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const session = createSession(user.id, req.headers['user-agent'], ip);
    res.setHeader('Set-Cookie', serializeCookie(session.id));
    audit('auth.login', { userId: user.id, detail: { ip } });
    log.info('login', { userId: user.id, username: user.username, ip });
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', authed, (req, res) => {
    deleteSession(req.sessionId!);
    res.setHeader('Set-Cookie', serializeCookie(null));
    audit('auth.logout', { userId: req.user!.id });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', authed, (req, res) => {
    res.json({ user: publicUser(req.user!) });
  });

  app.post('/api/auth/password', authed, (req, res) => {
    const parsed = z.object({ password: z.string().min(8).max(256) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'password_too_short' });
    setUserPassword(req.user!.id, parsed.data.password);
    audit('auth.password.change', { userId: req.user!.id });
    res.json({ ok: true });
  });

  // --- state ---------------------------------------------------------------

  app.get('/api/state', authed, (req, res) => {
    touchUser(req.user!.id, null);
    res.json({ state: hub().state(), self: publicUser(req.user!) });
  });

  app.get('/api/metrics', authed, (_req, res) => {
    if (!config.metricsEnabled) return res.status(404).json({ error: 'disabled' });
    res.json(rt.metrics.snapshot(hub().connectionCount()));
  });

  /** Unauthenticated liveness probe for Docker/compose healthchecks. */
  app.get('/api/health', (_req, res) => {
    const ok = rt.browser.status === 'running';
    res.status(ok ? 200 : 503).json({
      status: rt.browser.status,
      browserId: rt.browser.browserId,
      tabs: rt.tabs.count,
      cdpLatencyMs: rt.health.cdpLatencyMs,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  /**
   * Self-contained animated page for benchmarking and troubleshooting.
   *
   * Unauthenticated on purpose: the shared Chromium fetches it and has no
   * session cookie. It contains no data - just a moving gradient and a counter -
   * and it exists so the stream can be exercised and measured on an isolated LAN
   * with no Internet access at all.
   */
  app.get('/selftest', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    // The app-wide CSP forbids inline scripts, which is right for the app and
    // fatal for this page - its whole job is an inline animation loop. Narrow
    // override: no network access of any kind, only its own inline script/style.
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
    res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Stream self-test</title></head>
<body style="margin:0;height:100vh;display:grid;place-items:center;font:600 clamp(24px,6vw,64px)/1.3 system-ui,sans-serif;color:#fff;background:#111">
  <div style="text-align:center">
    <!-- A paste target, top-left at a fixed position: input coming from a
         viewer's clipboard is the one thing that cannot be checked by looking at
         pixels, so its value is mirrored into the title below. -->
    <input id="p" placeholder="paste target" aria-label="paste target"
           style="position:fixed;left:20px;top:20px;width:360px;height:36px;font-size:16px">
    <div id="t">--</div>
    <div id="n" style="font-size:.45em;opacity:.75">repaints: 0</div>
    <div id="bar" style="margin-top:.6em;height:22px;width:60vw;background:linear-gradient(90deg,#0ea5e9,#a855f7,#f59e0b);border-radius:11px"></div>
  </div>
  <script>
    var i = 0;
    var t = document.getElementById('t'), n = document.getElementById('n'), bar = document.getElementById('bar');
    var p = document.getElementById('p');
    // setInterval, not requestAnimationFrame: rAF is tied to the compositor and
    // to page visibility, and this page has to keep changing pixels even in a
    // tab nobody is looking at - that is the whole point of a load generator.
    setInterval(function () {
      i++;
      t.textContent = new Date().toISOString().slice(11, 23);
      n.textContent = 'repaints: ' + i;
      bar.style.transform = 'translateX(' + Math.round(Math.sin(i / 15) * 40) + 'px)';
      // Mirrored into the title so the server (and docs/troubleshooting.md) can
      // tell "page JS is not running" apart from "frames are not arriving".
      if (i % 10 === 0) document.title = (p.value ? 'pasted:' + p.value + ' ' : '') + 'self-test ' + i;
    }, 33);
  </script>
</body></html>`);
  });

  // --- admin ---------------------------------------------------------------

  app.get('/api/admin/users', authed, adminOnly, (_req, res) => {
    res.json({ users: listUsers().map(publicUser) });
  });

  app.post('/api/admin/users', authed, adminOnly, (req, res) => {
    const parsed = z
      .object({
        username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
        password: z.string().min(8).max(256),
        role: Role,
        displayName: z.string().max(64).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request', detail: parsed.error.issues[0]?.message });
    if (getUserByName(parsed.data.username)) return res.status(409).json({ error: 'username_taken' });
    const user = createUser(parsed.data.username, parsed.data.password, parsed.data.role, parsed.data.displayName);
    audit('admin.user.create', { userId: req.user!.id, detail: { created: user.id, role: user.role } });
    res.status(201).json({ user: publicUser(user) });
  });

  app.patch('/api/admin/users/:userId', authed, adminOnly, (req, res) => {
    const parsed = z
      .object({ role: Role.optional(), password: z.string().min(8).max(256).optional() })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
    const target = param(req, 'userId');
    if (parsed.data.role) setUserRole(target, parsed.data.role);
    if (parsed.data.password) setUserPassword(target, parsed.data.password);
    audit('admin.user.update', { userId: req.user!.id, detail: { target, role: parsed.data.role } });
    res.json({ ok: true });
  });

  app.delete('/api/admin/users/:userId', authed, adminOnly, (req, res) => {
    if (param(req, 'userId') === req.user!.id) return res.status(400).json({ error: 'cannot_delete_self' });
    hub().disconnectUser(param(req, 'userId'), 'account removed');
    deleteUserSessions(param(req, 'userId'));
    deleteUser(param(req, 'userId'));
    audit('admin.user.delete', { userId: req.user!.id, detail: { target: param(req, 'userId') } });
    res.json({ ok: true });
  });

  app.post('/api/admin/users/:userId/disconnect', authed, adminOnly, (req, res) => {
    const closed = hub().disconnectUser(param(req, 'userId'));
    deleteUserSessions(param(req, 'userId'));
    audit('admin.user.disconnect', { userId: req.user!.id, detail: { target: param(req, 'userId'), closed } });
    res.json({ ok: true, closed });
  });

  app.post('/api/admin/browser/restart', authed, adminOnly, (req, res) => {
    audit('admin.browser.restart', { userId: req.user!.id });
    // Fire and forget: the restart takes seconds and clients learn from the
    // browser.status broadcast, not from this response.
    void rt.browser.restart().catch((err) => log.error('admin restart failed', { err }));
    res.status(202).json({ ok: true });
  });

  app.get('/api/admin/cookies', authed, adminOnly, (_req, res) => {
    void rt.cookies
      .summarize()
      .then((domains) => res.json({ domains }))
      .catch(() => res.status(503).json({ error: 'browser_unavailable' }));
  });

  app.delete('/api/admin/cookies', authed, adminOnly, (req, res) => {
    const domain = typeof req.query.domain === 'string' ? req.query.domain : null;
    audit('admin.cookies.clear', { userId: req.user!.id, detail: { domain } });
    void (domain ? rt.cookies.clearDomain(domain) : rt.cookies.clearAll())
      .then(() => res.json({ ok: true }))
      .catch(() => res.status(503).json({ error: 'browser_unavailable' }));
  });

  app.get('/api/admin/audit', authed, adminOnly, (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    res.json({ events: recentAudit(Number.isFinite(limit) ? limit : 100) });
  });

  // --- bookmarks, history, address-bar suggestions --------------------------

  app.get('/api/bookmarks', authed, (_req, res) => res.json({ bookmarks: listBookmarks() }));

  app.post('/api/bookmarks', authed, (req, res) => {
    const parsed = z.object({ url: z.string().min(1).max(2048), title: z.string().max(300).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
    const url = normalizeUrl(parsed.data.url);
    if (!url) return res.status(400).json({ error: 'navigation_blocked' });
    const bookmark = addBookmark(url, parsed.data.title ?? '', req.user!.id);
    audit('bookmark.add', { userId: req.user!.id, detail: { url } });
    res.status(201).json({ bookmark });
  });

  app.delete('/api/bookmarks/:name', authed, (req, res) => {
    removeBookmark(param(req, 'name'));
    res.json({ ok: true });
  });

  app.get('/api/history', authed, (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json({ history: q ? searchHistory(q, 50) : recentHistory(100) });
  });

  app.delete('/api/history', authed, adminOnly, (req, res) => {
    clearHistory();
    audit('history.clear', { userId: req.user!.id });
    res.json({ ok: true });
  });

  /** Bookmarks first, then history - what the address bar dropdown shows. */
  app.get('/api/suggest', authed, (req, res) => {
    const q = (typeof req.query.q === 'string' ? req.query.q : '').trim();
    if (q.length < 1) return res.json({ suggestions: [] });
    const seen = new Set<string>();
    const suggestions = [
      ...searchBookmarks(q, 4).map((b) => ({ kind: 'bookmark' as const, url: b.url, title: b.title })),
      ...searchHistory(q, 8).map((h) => ({ kind: 'history' as const, url: h.url, title: h.title })),
    ].filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
    res.json({ suggestions: suggestions.slice(0, 8) });
  });

  // --- extensions ----------------------------------------------------------

  /**
   * The installed extensions, for the extensions panel. Readable by anyone
   * signed in - it is the same list the toolbar of a normal browser shows -
   * while installing and removing stays admin-only below.
   */
  app.get('/api/extensions', authed, (_req, res) => {
    if (!config.extensionsEnabled) return res.json({ extensions: [] });
    res.json({
      extensions: listExtensions().map((e) => ({
        id: e.id,
        name: e.name,
        version: e.version,
        hasPopup: !!e.popupPath,
        hasOptions: !!e.optionsPath,
      })),
    });
  });

  /**
   * Open an extension's popup or options page.
   *
   * Extension popups are native Chromium windows: they are not part of any
   * page's compositor surface, so they can never appear in a screencast. The
   * page behind the popup is ordinary HTML though, so it is opened as a tab -
   * which is also how you would reach an options page in a normal browser.
   *
   * The client sends an extension id, never a URL: the chrome-extension://
   * address is built here from the installed list.
   */
  app.post('/api/extensions/:name/open', authed, (req, res) => {
    if (!config.extensionsEnabled) return res.status(404).json({ error: 'disabled' });
    if (!roleCan(req.user!.role, 'tab.create')) return res.status(403).json({ error: 'forbidden' });
    const found = listExtensions().find((e) => e.id === param(req, 'name'));
    if (!found) return res.status(404).json({ error: 'not_found' });
    const wantOptions = req.query.page === 'options';
    const page = (wantOptions ? found.optionsPath : found.popupPath) ?? found.optionsPath ?? found.popupPath;
    if (!page) return res.status(404).json({ error: 'no_page' });
    void rt.tabs
      .createTab({
        trustedUrl: `chrome-extension://${found.chromeId}/${page}`,
        label: found.name,
        createdBy: req.user!.id,
      })
      .catch((err) => log.warn('extension page could not be opened', { id: found.id, err: err as Error }));
    res.status(202).json({ ok: true });
  });

  app.get('/api/admin/extensions', authed, adminOnly, (_req, res) => {
    if (!config.extensionsEnabled) return res.status(404).json({ error: 'disabled' });
    res.json({
      extensions: listExtensions().map((e) => ({
        id: e.id,
        name: e.name,
        version: e.version,
        manifestVersion: e.manifestVersion,
        permissions: e.permissions,
        sizeBytes: e.sizeBytes,
      })),
      // Chromium reads --load-extension once, at launch.
      restartRequiredToApply: true,
    });
  });

  /**
   * Unpack a zip that is already on disk into the extensions directory. Shared
   * by the upload and the Web Store routes: same validation, same failure modes.
   */
  const unpackExtension = (id: string, zipPath: string, res: Response, userId: string) => {
    const target = path.join(config.extensionsDir, id);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    // unzip rather than a zip library: it is one apt package, it handles the
    // odd archive, and nothing here is on a hot path.
    const out = spawnSync('unzip', ['-qq', '-o', zipPath, '-d', target], { timeout: 60_000 });
    rmSync(zipPath, { force: true });
    if (out.status !== 0) {
      rmSync(target, { recursive: true, force: true });
      const detail = (out.stderr?.toString() || out.error?.message || 'unzip failed').slice(0, 200);
      log.warn('extension unpack failed', { id, detail });
      return res.status(400).json({ error: 'unpack_failed', detail });
    }
    const found = listExtensions().find((e) => e.id === id);
    if (!found) {
      rmSync(target, { recursive: true, force: true });
      return res.status(400).json({ error: 'no_manifest', detail: 'the archive has no manifest.json' });
    }
    audit('admin.extension.install', { userId, detail: { id, name: found.name, version: found.version } });
    log.warn('extension installed', { id, name: found.name, version: found.version });
    return res.status(201).json({ extension: found, restartRequiredToApply: true });
  };

  /**
   * Install straight from the Chrome Web Store, by id or store URL.
   *
   * The extension is downloaded, unwrapped and unpacked - not verified. It runs
   * in the shared browser with whatever permissions its manifest asks for, so
   * this is admin-only and audited, exactly like an uploaded zip.
   */
  app.post('/api/admin/extensions/store', authed, adminOnly, (req, res) => {
    if (!config.extensionsEnabled) return res.status(404).json({ error: 'disabled' });
    const storeId = parseStoreId(String((req.body as { id?: unknown })?.id ?? ''));
    if (!storeId) return res.status(400).json({ error: 'bad_id', detail: 'expected a Web Store id or URL' });

    void downloadFromWebStore(storeId, rt.browser.chromeVersion)
      .then((zip) => {
        mkdirSync(config.extensionsDir, { recursive: true });
        const zipPath = path.join(config.extensionsDir, `${storeId}.store.zip`);
        writeFileSync(zipPath, zip);
        unpackExtension(storeId, zipPath, res, req.user!.id);
      })
      .catch((err) => {
        log.warn('web store install failed', { storeId, err: err as Error });
        if (!res.headersSent)
          res.status(502).json({ error: 'store_failed', detail: String((err as Error).message).slice(0, 120) });
      });
  });

  /**
   * Upload an extension as a .zip and unpack it. The route above installs the
   * same thing straight from the Web Store; this one is for an extension that is
   * not published there, or one an admin wants to read before running.
   */
  app.post('/api/admin/extensions/:name', authed, adminOnly, (req, res) => {
    if (!config.extensionsEnabled) return res.status(404).json({ error: 'disabled' });
    const id = safeName(param(req, 'name')).replace(/\.zip$/i, '') || `ext-${Date.now()}`;
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > config.maxUploadBytes) return res.status(413).json({ error: 'too_large' });

    mkdirSync(config.extensionsDir, { recursive: true });
    const zipPath = path.join(config.extensionsDir, `${id}.upload.zip`);
    let written = 0;
    req.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > config.maxUploadBytes) req.destroy();
    });

    void pipeline(req, createWriteStream(zipPath))
      .then(() => unpackExtension(id, zipPath, res, req.user!.id))
      .catch((err) => {
        rmSync(zipPath, { force: true });
        log.warn('extension upload failed', { id, err: err as Error });
        if (!res.headersSent) res.status(400).json({ error: 'upload_failed' });
      });
  });

  app.delete('/api/admin/extensions/:name', authed, adminOnly, (req, res) => {
    if (!config.extensionsEnabled) return res.status(404).json({ error: 'disabled' });
    const id = param(req, 'name');
    if (!removeExtension(id)) return res.status(404).json({ error: 'not_found' });
    audit('admin.extension.remove', { userId: req.user!.id, detail: { id } });
    res.json({ ok: true, restartRequiredToApply: true });
  });

  // --- tab permissions -----------------------------------------------------

  app.get('/api/tabs/:tabId/grants', authed, (req, res) => {
    if (!rt.tabs.get(param(req, 'tabId'))) return res.status(404).json({ error: 'tab_not_found' });
    res.json({ grants: listTabGrants(param(req, 'tabId')) });
  });

  app.put('/api/tabs/:tabId/grants/:userId', authed, (req, res) => {
    if (req.user!.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const parsed = z.object({ permission: TabPermission }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
    grantTab(param(req, 'tabId'), param(req, 'userId'), parsed.data.permission);
    audit('tab.grant', {
      userId: req.user!.id,
      tabId: param(req, 'tabId'),
      detail: { target: param(req, 'userId'), permission: parsed.data.permission },
    });
    hub().broadcast({ type: 'tab.permissions', tabId: param(req, 'tabId'), permission: parsed.data.permission });
    res.json({ ok: true });
  });

  app.delete('/api/tabs/:tabId/grants/:userId', authed, (req, res) => {
    if (req.user!.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    revokeTab(param(req, 'tabId'), param(req, 'userId'));
    audit('tab.revoke', { userId: req.user!.id, tabId: param(req, 'tabId'), detail: { target: param(req, 'userId') } });
    res.json({ ok: true });
  });

  // --- downloads / uploads -------------------------------------------------

  const safeName = (name: string) => path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

  app.get('/api/downloads', authed, (_req, res) => {
    if (!config.downloadsEnabled) return res.status(404).json({ error: 'disabled' });
    const files = readdirSync(config.downloadDir, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.endsWith('.crdownload'))
      .map((d) => {
        const st = statSync(path.join(config.downloadDir, d.name));
        return { name: d.name, size: st.size, modified: st.mtimeMs };
      })
      .sort((a, b) => b.modified - a.modified);
    res.json({ files });
  });

  app.get('/api/downloads/:name', authed, (req, res) => {
    if (!config.downloadsEnabled) return res.status(404).json({ error: 'disabled' });
    // basename() is the whole defence against ../../etc/passwd.
    const file = path.join(config.downloadDir, path.basename(param(req, 'name')));
    if (!existsSync(file)) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Content-Disposition', `attachment; filename="${safeName(param(req, 'name'))}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    createReadStream(file).pipe(res);
  });

  app.delete('/api/downloads/:name', authed, (req, res) => {
    const file = path.join(config.downloadDir, path.basename(param(req, 'name')));
    if (existsSync(file)) unlinkSync(file);
    res.json({ ok: true });
  });

  app.get('/api/uploads', authed, (_req, res) => {
    if (!config.uploadsEnabled) return res.status(404).json({ error: 'disabled' });
    const files = readdirSync(config.uploadDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => ({ name: d.name, size: statSync(path.join(config.uploadDir, d.name)).size }));
    res.json({ files });
  });

  /**
   * Raw-body upload into UPLOAD_DIR. Chromium can only ever see this directory,
   * so a page cannot reach anything else on the container filesystem.
   */
  app.post('/api/uploads/:name', authed, (req, res) => {
    if (!config.uploadsEnabled) return res.status(404).json({ error: 'disabled' });
    if (!roleCan(req.user!.role, 'input.send')) return res.status(403).json({ error: 'forbidden' });
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > config.maxUploadBytes) return res.status(413).json({ error: 'too_large' });
    const name = safeName(param(req, 'name'));
    const target = path.join(config.uploadDir, name);
    let written = 0;
    req.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > config.maxUploadBytes) req.destroy();
    });
    void pipeline(req, createWriteStream(target))
      .then(() => {
        audit('file.upload', { userId: req.user!.id, detail: { name, bytes: written } });
        res.status(201).json({ name, size: written });
      })
      .catch(() => res.status(400).json({ error: 'upload_failed' }));
  });

  mountDevtools(app, rt, authed, adminOnly);

  return app;
}

/** Route params exist whenever the route matched; this keeps TS happy without noise. */
const param = (req: Request, name: string): string => req.params[name] ?? '';

function publicUser(u: UserRow) {
  return {
    userId: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    createdAt: u.created_at,
    lastSeenAt: u.last_seen_at,
    lastTabId: u.last_tab_id,
  };
}

export { COOKIE_NAME };
