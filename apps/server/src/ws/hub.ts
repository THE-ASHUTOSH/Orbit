/**
 * WebSocket hub: the only path from a browser client to the shared Chromium.
 *
 * Identity comes from the session cookie at upgrade time - a client's userId is
 * never read off the wire, so it cannot claim to be someone else. Every message
 * is validated with the shared zod schema and then authorized server-side before
 * it reaches a manager.
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ClientMessage,
  ERROR_MESSAGES,
  PROTOCOL_VERSION,
  colorForIndex,
  type BrowserState,
  type Cursor,
  type ErrorCode,
  type PresenceState,
  type ServerMessage,
  type UserInfo,
} from '@orbit/protocol';
import { config } from '../config.js';
import { log } from '../log.js';
import { id } from '../ids.js';
import { audit, getUser, lastClosedTab, recordVisit, touchUser, userColorIndex, type UserRow } from '../db.js';
import { sessionFromRequest } from '../auth/session.js';
import { canAdminTab, canControlTab, canViewTab, effectivePermission, roleCan } from '../auth/permissions.js';
import { isOriginAllowed } from '../api/origin.js';
import type { Runtime } from '../runtime.js';
import type { FrameSink } from '../browser/StreamManager.js';

const HEARTBEAT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const CURSOR_FLUSH_MS = 50; // 20Hz is plenty for a cursor overlay
const RECONNECT_GRACE_MS = 30_000;
const IDLE_AFTER_MS = 60_000;

class Connection implements FrameSink {
  readonly id = id('conn');
  readonly subscriptions = new Set<string>();
  lastPongAt = Date.now();
  lastActivityAt = Date.now();
  clientSequence = -1;
  private tokens: number;
  private lastRefill = Date.now();
  private strikes = 0;

  constructor(
    readonly ws: WebSocket,
    readonly user: UserRow,
    readonly sessionId: string,
    readonly ip: string,
  ) {
    this.tokens = config.maxMessageRate;
  }

  get userId(): string {
    return this.user.id;
  }

  /** Token bucket. Returns false when the client is over its message budget. */
  allow(): boolean {
    const now = Date.now();
    this.tokens = Math.min(config.maxMessageRate, this.tokens + ((now - this.lastRefill) / 1000) * config.maxMessageRate);
    this.lastRefill = now;
    if (this.tokens < 1) {
      this.strikes++;
      return false;
    }
    this.tokens -= 1;
    return true;
  }
  get abusive(): boolean {
    return this.strikes > 50;
  }

  send(data: Uint8Array | ServerMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (data instanceof Uint8Array) this.ws.send(data, { binary: true });
    else this.ws.send(JSON.stringify(data));
  }
  bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }
  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
  fail(code: ErrorCode, tabId?: string): void {
    this.send({ type: 'error', code, message: ERROR_MESSAGES[code], ...(tabId ? { tabId } : {}) });
  }
}

export class Hub {
  private wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  private connections = new Map<string, Connection>();
  /** userId -> when their last connection dropped, for the "reconnecting" state. */
  private recentlyGone = new Map<string, number>();
  private cursors = new Map<string, Map<string, Cursor>>();
  /** Last URL recorded in history per tab, to avoid counting one load twice. */
  private lastRecordedUrl = new Map<string, string>();
  private cursorDirty = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private shuttingDown = false;

  constructor(private readonly rt: Runtime) {
    this.rt.tabs.on('tab.created', (tab) => {
      // Explicit creates carry their requester; a popup is attributed to whoever
      // was last driving the tab that opened it.
      const openedBy = tab.createdBy ?? (tab.openerTabId ? this.rt.input.lastActor(tab.openerTabId) : null);
      this.broadcast({ type: 'tab.created', tab: this.rt.tabInfo(tab), openedBy }, (c) =>
        canViewTab(c.user, tab.tabId),
      );
    });
    this.rt.tabs.on('tab.closed', (tabId: string) => {
      this.rt.input.dropTab(tabId);
      void this.rt.streams.stop(tabId, 'tab closed');
      this.cursors.delete(tabId);
      this.lastRecordedUrl.delete(tabId);
      for (const c of this.connections.values()) c.subscriptions.delete(tabId);
      this.broadcast({ type: 'tab.closed', tabId });
    });
    this.rt.tabs.on('tab.updated', (tab) =>
      this.broadcast({ type: 'tab.updated', tab: this.rt.tabInfo(tab) }, (c) => canViewTab(c.user, tab.tabId)),
    );
    this.rt.tabs.on('tab.navigation', (tab) => {
      // History: one entry per URL, recorded when a tab actually lands somewhere
      // new. Guarded per tab so the several navigation events a single page load
      // produces do not each count as a visit.
      if (tab.url && this.lastRecordedUrl.get(tab.tabId) !== tab.url && !tab.loading) {
        this.lastRecordedUrl.set(tab.tabId, tab.url);
        recordVisit(tab.url, tab.title);
      }
      this.broadcast(
        { type: 'tab.navigation', tabId: tab.tabId, url: tab.url, title: tab.title, loading: tab.loading },
        (c) => canViewTab(c.user, tab.tabId),
      );
    });
    this.rt.tabs.on('tab.resized', (tab) => {
      void this.rt.streams.restart(tab.tabId);
      // Without this the zoom readout only refreshes on the next unrelated tab
      // event, so the number and the picture change at different moments.
      this.broadcast({ type: 'tab.updated', tab: this.rt.tabInfo(tab) }, (c) => canViewTab(c.user, tab.tabId));
    });
    this.rt.tabs.on('tab.crashed', (tab) => {
      // The renderer is new after a reload, so the old screencast is gone.
      setTimeout(() => void this.rt.streams.restart(tab.tabId), 1500);
      this.broadcast({ type: 'error', code: 'page_crashed', message: ERROR_MESSAGES.page_crashed, tabId: tab.tabId }, (c) =>
        c.subscriptions.has(tab.tabId),
      );
    });
    this.rt.tabs.on('page.attached', (tab) => void this.rt.installPageHooks(tab));

    this.rt.browser.on('status', (status, message) => {
      this.broadcast({ type: 'browser.status', status, ...(message ? { message } : {}), restarts: this.rt.browser.restarts });
      if (status === 'running') this.broadcast({ type: 'state', state: this.state() });
    });

    // Browser-originated notifications that need to reach humans.
    this.rt.on('file.chooser', (p) =>
      this.broadcast({ type: 'file.chooser', tabId: p.tabId, multiple: p.multiple, accept: p.accept }, (c) =>
        c.subscriptions.has(p.tabId) && canControlTab(c.user, p.tabId),
      ),
    );
    this.rt.on('download', (p) => this.broadcast({ type: 'download', ...p }));
    this.rt.on('clipboard', (p) =>
      this.broadcast({ type: 'clipboard.data', tabId: p.tabId, text: p.text }, (c) =>
        c.subscriptions.has(p.tabId) && canControlTab(c.user, p.tabId),
      ),
    );

    this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.flushCursors(), CURSOR_FLUSH_MS));
    if (config.metricsEnabled) this.timers.push(setInterval(() => this.pushMetrics(), 2000));
    for (const t of this.timers) t.unref();
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Claim a websocket upgrade. Returns false, without touching the socket, when
   * the path belongs to someone else - the DevTools proxy also handles upgrades,
   * so exactly one handler must own each path.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (!req.url?.startsWith('/ws')) return false;
    this.onUpgrade(req, socket, head);
    return true;
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const deny = (code: number, why: string) => {
      log.warn('ws upgrade rejected', { why, url: req.url, ip: clientIp(req) });
      socket.write(`HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    // Browsers do not enforce same-origin on WebSockets, so the server must.
    if (!isOriginAllowed(req.headers.origin, req.headers.host)) return deny(403, 'origin not allowed');
    if (this.shuttingDown) return deny(503 as 403, 'shutting down');

    const session = sessionFromRequest(req);
    if (!session) return deny(401, 'no valid session');

    const distinctUsers = new Set([...this.connections.values()].map((c) => c.userId));
    if (!distinctUsers.has(session.user.id) && distinctUsers.size >= config.maxUsers) return deny(403, 'user limit');

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws, session.user, session.sessionId, clientIp(req));
    });
  }

  private onConnection(ws: WebSocket, user: UserRow, sessionId: string, ip: string): void {
    const conn = new Connection(ws, user, sessionId, ip);
    this.connections.set(conn.id, conn);
    this.recentlyGone.delete(user.id);
    const clog = log.child({ userId: user.id, username: user.username, sessionId });
    clog.info('user connected', { connId: conn.id, ip });
    audit('user.connect', { userId: user.id, detail: { ip } });

    ws.on('pong', () => {
      conn.lastPongAt = Date.now();
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return conn.fail('invalid_message'); // clients never send binary
      this.onMessage(conn, data.toString('utf8'));
    });
    ws.on('close', () => this.onClose(conn));
    ws.on('error', (err) => clog.warn('ws error', { err }));

    conn.send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      self: this.userInfo(user, 'online'),
      serverTime: Date.now(),
      state: this.state(),
    });
    this.broadcastPresence();
  }

  private onClose(conn: Connection): void {
    this.connections.delete(conn.id);
    this.rt.streams.unsubscribeAll(conn.id);
    for (const tabId of conn.subscriptions) this.dropCursor(tabId, conn.userId);
    const stillHere = [...this.connections.values()].some((c) => c.userId === conn.userId);
    if (!stillHere) {
      this.recentlyGone.set(conn.userId, Date.now());
      touchUser(conn.userId, null);
    }
    log.info('user disconnected', { userId: conn.userId, connId: conn.id, stillConnected: stillHere });
    audit('user.disconnect', { userId: conn.userId });
    this.broadcastPresence();
  }

  // --- messages ------------------------------------------------------------

  private onMessage(conn: Connection, raw: string): void {
    if (!conn.allow()) {
      conn.fail('rate_limited');
      if (conn.abusive && conn.ws.readyState === WebSocket.OPEN) {
        log.warn('closing abusive connection', { userId: conn.userId, connId: conn.id });
        conn.ws.close(1008, 'rate limit');
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return conn.fail('invalid_message');
    }
    const result = ClientMessage.safeParse(parsed);
    if (!result.success) {
      log.debug('rejected malformed message', { userId: conn.userId, issue: result.error.issues[0]?.message });
      return conn.fail('invalid_message');
    }
    const msg = result.data;
    conn.lastActivityAt = Date.now();

    try {
      this.route(conn, msg);
    } catch (err) {
      const code = errorCode(err);
      if (code === 'internal') log.error('message handler failed', { userId: conn.userId, type: msg.type, err: err as Error });
      conn.fail(code, 'tabId' in msg ? msg.tabId : undefined);
    }
  }

  /**
   * Failure path for async handlers. An unmapped error is a server bug, so it is
   * logged in full server-side while the client only ever sees a stable code.
   */
  private failAsync(conn: Connection, err: unknown, type: string, tabId?: string): void {
    const code = errorCode(err);
    if (code === 'internal') log.error('handler failed', { userId: conn.userId, type, tabId, err: err as Error });
    else log.debug('handler rejected', { userId: conn.userId, type, tabId, code });
    conn.fail(code, tabId);
  }

  /**
   * Attach a connection to a tab's stream.
   *
   * Retries once through a browser restart: the tab still exists but its CDP
   * session is rebuilt asynchronously, so a subscribe landing in that window
   * would otherwise fail permanently and leave the user staring at a dead
   * viewport until they clicked another tab.
   */
  private async subscribe(conn: Connection, msg: Extract<ClientMessage, { type: 'tab.subscribe' }>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const tab = this.rt.tabs.require(msg.tabId);
        conn.subscriptions.add(msg.tabId);
        touchUser(conn.userId, msg.tabId);
        const firstSubscriber = this.rt.streams.subscriberCount(msg.tabId) === 0;
        if (config.pinViewport) {
          // Pinned resolution, but the viewer's aspect ratio: the width is fixed
          // and the height follows the window, so nothing is letterboxed and no
          // pixels are spent on black bars. Only the first subscriber sets the
          // shape - later joiners must not reshape the tab under everyone else.
          const aspect =
            firstSubscriber && msg.width && msg.height
              ? msg.height / msg.width
              : config.viewport.height / config.viewport.width;
          // Configured width, viewer's aspect. The window follows, so this can
          // grow as well as shrink.
          const width = config.viewport.width;
          await this.rt.tabs.resize(msg.tabId, width, Math.round(width * aspect));
        } else if (firstSubscriber && msg.width && msg.height) {
          // Otherwise the first subscriber decides, and later joiners scale the
          // frame locally rather than forcing a resize on everyone else.
          await this.rt.tabs.resize(msg.tabId, msg.width, msg.height);
        }
        const { width, height } = await this.rt.streams.subscribe(msg.tabId, conn);
        conn.send({ type: 'stream.started', tabId: msg.tabId, width, height });
        conn.send({
          type: 'tab.permissions',
          tabId: msg.tabId,
          permission: effectivePermission(conn.user, msg.tabId),
        });
        this.broadcastTabViewers(msg.tabId);
        this.broadcastPresence();
        void tab;
        return;
      } catch (err) {
        if (attempt >= 1 || errorCode(err) !== 'browser_unavailable') throw err;
        log.info('subscribe arrived during browser recovery - waiting', { tabId: msg.tabId, userId: conn.userId });
        await this.rt.browser.waitUntilReady(20_000);
      }
    }
  }

  private route(conn: Connection, msg: ClientMessage): void {
    switch (msg.type) {
      case 'ping':
        return conn.send({ type: 'pong', ...(msg.t !== undefined ? { t: msg.t } : {}), serverTime: Date.now() });

      case 'input.mouse':
      case 'input.keyboard':
      case 'input.text':
      case 'input.touch': {
        if (!canControlTab(conn.user, msg.tabId)) {
          // Logged because "my clicks do nothing" is otherwise invisible: the
          // client only sees a generic refusal.
          log.debug('input denied', {
            userId: conn.userId,
            role: conn.user.role,
            tabId: msg.tabId,
            type: msg.type,
            effective: effectivePermission(conn.user, msg.tabId),
          });
          return conn.fail('forbidden', msg.tabId);
        }
        this.rt.tabs.require(msg.tabId);
        const accepted = this.rt.input.submit(msg, conn.userId, conn.id);
        if (!accepted) log.debug('duplicate input dropped', { userId: conn.userId, eventId: msg.eventId });
        return;
      }

      case 'cursor': {
        if (!canViewTab(conn.user, msg.tabId)) return conn.fail('forbidden', msg.tabId);
        const perTab = this.cursors.get(msg.tabId) ?? new Map<string, Cursor>();
        this.cursors.set(msg.tabId, perTab);
        perTab.set(conn.userId, {
          userId: conn.userId,
          displayName: conn.user.display_name,
          color: colorForIndex(userColorIndex(conn.userId)),
          x: msg.x,
          y: msg.y,
          active: msg.active,
          at: Date.now(),
        });
        this.cursorDirty.add(msg.tabId);
        return;
      }

      case 'tab.subscribe': {
        if (!canViewTab(conn.user, msg.tabId)) return conn.fail('forbidden', msg.tabId);
        void this.subscribe(conn, msg).catch((err) => this.failAsync(conn, err, msg.type, msg.tabId));
        return;
      }

      case 'tab.unsubscribe': {
        conn.subscriptions.delete(msg.tabId);
        this.rt.streams.unsubscribe(msg.tabId, conn.id);
        this.dropCursor(msg.tabId, conn.userId);
        conn.send({ type: 'stream.stopped', tabId: msg.tabId, reason: 'unsubscribed' });
        this.broadcastTabViewers(msg.tabId);
        return;
      }

      case 'tab.create': {
        if (!roleCan(conn.user.role, 'tab.create')) return conn.fail('forbidden');
        void this.rt.tabs
          .createTab({ url: msg.url ?? null, label: msg.label ?? null, createdBy: conn.userId })
          .catch((err) => this.failAsync(conn, err, msg.type));
        return;
      }

      case 'tab.close': {
        if (!canAdminTab(conn.user, msg.tabId) && !roleCan(conn.user.role, 'tab.close')) return conn.fail('forbidden', msg.tabId);
        audit('tab.close', { userId: conn.userId, tabId: msg.tabId });
        void this.rt.tabs.close(msg.tabId).catch((err) => this.failAsync(conn, err, msg.type, msg.tabId));
        return;
      }

      case 'tab.navigate': {
        if (!canControlTab(conn.user, msg.tabId)) return conn.fail('forbidden', msg.tabId);
        audit('tab.navigate', { userId: conn.userId, tabId: msg.tabId, detail: { url: msg.url.slice(0, 200) } });
        void this.rt.tabs.navigate(msg.tabId, msg.url).catch((err) => this.failAsync(conn, err, msg.type, msg.tabId));
        return;
      }

      case 'tab.action': {
        if (!canControlTab(conn.user, msg.tabId)) return conn.fail('forbidden', msg.tabId);
        void this.rt.tabs.action(msg.tabId, msg.action).catch((err) => this.failAsync(conn, err, msg.type, msg.tabId));
        return;
      }

      case 'tab.rename': {
        if (!canControlTab(conn.user, msg.tabId)) return conn.fail('forbidden', msg.tabId);
        this.rt.tabs.rename(msg.tabId, msg.label);
        return;
      }

      case 'tab.reopen': {
        if (!roleCan(conn.user.role, 'tab.create')) return conn.fail('forbidden');
        const closed = lastClosedTab();
        if (!closed) return;
        void this.rt.tabs
          .createTab({ url: closed.url, label: closed.label, createdBy: conn.userId })
          .catch((err) => this.failAsync(conn, err, msg.type));
        return;
      }

      case 'context.probe': {
        if (!canViewTab(conn.user, msg.tabId)) return conn.fail('forbidden', msg.tabId);
        void this.rt
          .probeContext(msg.tabId, msg.x, msg.y)
          .then((info) => conn.send({ type: 'context.info', tabId: msg.tabId, ...info }))
          .catch(() => conn.send({ type: 'context.info', tabId: msg.tabId, link: null, image: null, selection: '' }));
        return;
      }

      case 'tab.zoom': {
        if (!canControlTab(conn.user, msg.tabId)) return conn.fail('forbidden', msg.tabId);
        // The viewport is shared, so this changes the view for everyone on the tab.
        void this.rt.tabs.setZoom(msg.tabId, msg.zoom).catch((err) => this.failAsync(conn, err, msg.type, msg.tabId));
        return;
      }

      case 'tab.resize': {
        if (!canControlTab(conn.user, msg.tabId)) return conn.fail('forbidden', msg.tabId);
        void this.rt.tabs.resize(msg.tabId, msg.width, msg.height).catch((err) => this.failAsync(conn, err, msg.type, msg.tabId));
        return;
      }

      case 'clipboard.write': {
        if (!config.clipboardEnabled) return conn.fail('feature_disabled', msg.tabId);
        if (!canControlTab(conn.user, msg.tabId)) return conn.fail('forbidden', msg.tabId);
        const tab = this.rt.tabs.require(msg.tabId);
        this.rt.input.insertText(tab, msg.text);
        return;
      }

      case 'file.chooser.respond': {
        if (!config.uploadsEnabled) return conn.fail('feature_disabled', msg.tabId);
        if (!canControlTab(conn.user, msg.tabId)) return conn.fail('forbidden', msg.tabId);
        void this.rt.respondToFileChooser(msg.tabId, msg.files).catch((err) => this.failAsync(conn, err, msg.type, msg.tabId));
        return;
      }
    }
  }

  // --- presence & broadcast ------------------------------------------------

  private userInfo(user: UserRow, state: PresenceState): UserInfo {
    const conns = [...this.connections.values()].filter((c) => c.userId === user.id);
    const lastActivity = Math.max(0, ...conns.map((c) => c.lastActivityAt));
    const currentTabId = conns.flatMap((c) => [...c.subscriptions])[0] ?? user.last_tab_id ?? null;
    return {
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      color: colorForIndex(userColorIndex(user.id)),
      state,
      currentTabId,
      lastActivityAt: lastActivity || Date.now(),
    };
  }

  presence(): UserInfo[] {
    const out = new Map<string, UserInfo>();
    for (const conn of this.connections.values()) {
      const idle = Date.now() - conn.lastActivityAt > IDLE_AFTER_MS;
      out.set(conn.userId, this.userInfo(conn.user, idle ? 'idle' : 'online'));
    }
    // Users whose socket dropped seconds ago are "reconnecting", not gone: this
    // is what stops a wifi blip from flashing everyone out of the user list.
    for (const [userId, at] of this.recentlyGone) {
      if (Date.now() - at > RECONNECT_GRACE_MS) {
        this.recentlyGone.delete(userId);
        continue;
      }
      if (out.has(userId)) continue;
      const user = getUser(userId);
      if (user) out.set(userId, this.userInfo(user, 'reconnecting'));
    }
    return [...out.values()];
  }

  state(): BrowserState {
    return {
      browserId: this.rt.browser.browserId,
      status: this.rt.browser.status,
      startedAt: this.rt.browser.startTime,
      restarts: this.rt.browser.restarts,
      tabs: this.rt.tabs.list().map((t) => this.rt.tabInfo(t)),
      users: this.presence(),
      limits: { maxTabs: config.maxTabs, maxUsers: config.maxUsers, maxFps: config.maxFps },
      features: {
        clipboard: config.clipboardEnabled,
        downloads: config.downloadsEnabled,
        uploads: config.uploadsEnabled,
        webrtc: config.webrtcEnabled,
        devtools: config.devtoolsEnabled,
      },
    };
  }

  broadcast(msg: ServerMessage, filter?: (c: Connection) => boolean): void {
    for (const conn of this.connections.values()) {
      if (filter && !filter(conn)) continue;
      conn.send(msg);
    }
  }

  broadcastPresence(): void {
    this.broadcast({ type: 'presence', users: this.presence() });
  }

  private broadcastTabViewers(tabId: string): void {
    const tab = this.rt.tabs.get(tabId);
    if (!tab) return;
    this.broadcast({ type: 'tab.updated', tab: this.rt.tabInfo(tab) }, (c) => canViewTab(c.user, tabId));
  }

  /** Cursors are batched: one message per tab per tick, not one per mousemove. */
  private flushCursors(): void {
    for (const tabId of this.cursorDirty) {
      const perTab = this.cursors.get(tabId);
      if (!perTab) continue;
      for (const [userId, cur] of perTab) if (Date.now() - cur.at > 10_000) perTab.delete(userId);
      const cursors = [...perTab.values()];
      this.broadcast({ type: 'cursors', tabId, cursors }, (c) => c.subscriptions.has(tabId));
    }
    this.cursorDirty.clear();
  }

  private dropCursor(tabId: string, userId: string): void {
    const perTab = this.cursors.get(tabId);
    if (perTab?.delete(userId)) this.cursorDirty.add(tabId);
  }

  /** Ack for latency measurement; see docs/performance.md. */
  onInputDispatched(r: { eventId: string; tabId: string; serverReceiveTime: number; dispatchedAt: number; queueDepth: number }): void {
    this.broadcast({ type: 'input.ack', ...r }, (c) => c.subscriptions.has(r.tabId));
  }

  private pushMetrics(): void {
    const metrics = this.rt.metrics.snapshot(this.connections.size);
    this.broadcast({ type: 'metrics', metrics }, (c) => c.user.role === 'admin');
  }

  private heartbeat(): void {
    for (const conn of this.connections.values()) {
      if (Date.now() - conn.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        log.warn('heartbeat timeout - terminating ghost connection', { userId: conn.userId, connId: conn.id });
        conn.ws.terminate();
        this.onClose(conn);
        continue;
      }
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
    }
    this.broadcastPresence();
  }

  connectionCount(): number {
    return this.connections.size;
  }

  /** Admin: cut a specific user's sockets. */
  disconnectUser(userId: string, reason = 'disconnected by administrator'): number {
    let n = 0;
    for (const conn of [...this.connections.values()]) {
      if (conn.userId !== userId) continue;
      conn.send({ type: 'error', code: 'forbidden', message: reason });
      conn.ws.close(1000, 'administrator');
      n++;
    }
    return n;
  }

  async shutdown(reason: string): Promise<void> {
    this.shuttingDown = true;
    for (const t of this.timers) clearInterval(t);
    this.broadcast({ type: 'server.shutdown', reason });
    await new Promise((r) => setTimeout(r, 150)); // let the notice flush
    for (const conn of this.connections.values()) conn.ws.close(1001, 'server shutting down');
    this.connections.clear();
  }
}

function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Managers throw bare Error(code) strings; map them to protocol error codes. */
function errorCode(err: unknown): ErrorCode {
  const m = err instanceof Error ? err.message : String(err);
  const known = ['unauthorized', 'forbidden', 'tab_not_found', 'tab_limit', 'user_limit', 'browser_unavailable', 'navigation_blocked', 'feature_disabled', 'rate_limited', 'invalid_message'] as const;
  return (known as readonly string[]).includes(m) ? (m as ErrorCode) : 'internal';
}
