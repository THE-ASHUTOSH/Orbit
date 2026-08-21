/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Uses "flat" session mode (Target.attachToTarget with flatten:true), so every
 * page session multiplexes over ONE browser WebSocket: commands carry a
 * sessionId, events arrive tagged with one. That keeps a single socket for the
 * whole browser no matter how many tabs are open, which matters because this is
 * the hot path for both input dispatch and screencast frames.
 *
 * Deliberately hand-rolled rather than pulling in Playwright: we need raw
 * target/screencast control and per-session event routing, which is ~150 lines,
 * and an automation framework's page abstraction actively gets in the way.
 */
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { log } from '../log.js';

export interface CdpEvent<P = any> {
  method: string;
  params: P;
  sessionId?: string;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

export class CdpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly method?: string,
  ) {
    super(message);
    this.name = 'CdpError';
  }
}

/** Resolve the browser-level WebSocket endpoint, retrying while Chromium boots. */
export async function discoverEndpoint(port: number, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`CDP endpoint not reachable on 127.0.0.1:${port}: ${String(lastErr)}`);
}

/**
 * Resolve the endpoint from the profile's DevToolsActivePort file, which
 * Chromium writes once it is listening. This is the only way to use
 * --remote-debugging-port=0 (an OS-assigned port), which in turn is the only way
 * to be immune to port collisions - two instances on one machine, a test running
 * next to a dev server, a second container sharing the host network.
 */
export async function readActivePortEndpoint(profileDir: string, timeoutMs = 20_000): Promise<string> {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [port, wsPath] = (await readFile(file, 'utf8')).split('\n');
      if (port && wsPath) return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`chromium never reported a debugging port in ${file}`);
}

export class CdpConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly url: string) {
    super();
    this.setMaxListeners(0);
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // Frames arrive as base64 inside JSON events, so the per-message ceiling
      // has to comfortably exceed one full-size JPEG.
      const ws = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
      this.ws = ws;
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
      ws.on('message', (data) => this.onMessage(data as Buffer));
      ws.on('close', () => this.onClose());
    });
  }

  private onMessage(data: Buffer) {
    let msg: any;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      log.warn('cdp: unparseable message');
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(msg.error.message ?? 'CDP error', msg.error.code, p.method));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      const evt: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
      this.emit('event', evt);
      this.emit(msg.method, evt);
    }
  }

  private onClose() {
    const err = new CdpError('CDP connection closed');
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    if (!this.closed) {
      this.closed = true;
      this.emit('disconnected');
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Send a CDP command. `sessionId` targets a page session; omit it for
   * browser-level domains (Target, Browser).
   */
  send<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (!this.connected) return Promise.reject(new CdpError('CDP not connected', undefined, method));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP timeout after ${timeoutMs}ms`, undefined, method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      this.ws!.send(JSON.stringify(payload), (err) => {
        if (!err) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError(err.message, undefined, method));
      });
    });
  }

  /**
   * Fire-and-forget. Input events and frame acks are sent hundreds of times a
   * second and we never read their result: awaiting each one would add a
   * needless round-trip to the interaction path.
   */
  post(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    if (!this.connected) return;
    const payload: Record<string, unknown> = { id: this.nextId++, method, params };
    if (sessionId) payload.sessionId = sessionId;
    // Nothing awaits the id, so the reply is simply never claimed.
    this.ws!.send(JSON.stringify(payload));
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
