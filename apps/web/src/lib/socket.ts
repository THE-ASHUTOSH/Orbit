/**
 * Client transport.
 *
 * Owns reconnection, sequence numbers, clock-offset estimation and the latency
 * measurement described in docs/performance.md. Frames never touch React state:
 * they go straight from the socket to a per-tab callback that paints a canvas,
 * because re-rendering a component tree 30 times a second is exactly how you
 * lose the low-latency budget all that CDP work bought.
 */
import { decodeFrame, type ClientMessage, type FrameHeader, type ServerMessage } from '@orbit/protocol';

export type FrameListener = (header: FrameHeader, image: Uint8Array) => void;
export type MessageListener = (msg: ServerMessage) => void;
export type StatusListener = (status: ConnectionStatus) => void;

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'unauthorized';

export interface LatencySample {
  /** ping/pong round trip. */
  rttMs: number;
  /** Client send -> server accepted the input event. */
  inputMs: number;
  /** Server accepted -> server dispatched into Chromium (queue + arbiter). */
  queueMs: number;
  /** Client send -> first frame captured after dispatch was painted. */
  totalMs: number;
  /** Estimated server-client clock offset, for reference. */
  clockOffsetMs: number;
}

const MAX_BACKOFF_MS = 8000;

export class BrowserSocket {
  private ws: WebSocket | null = null;
  private frameListeners = new Map<string, Set<FrameListener>>();
  private messageListeners = new Set<MessageListener>();
  private statusListeners = new Set<StatusListener>();
  private sequence = 0;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private closedByUs = false;
  private eventCounter = 0;

  /** Estimated (serverClock - clientClock). Used only for reporting. */
  clockOffsetMs = 0;
  rttMs = 0;
  private lastInput: { eventId: string; sentAt: number } | null = null;
  private awaitingFrameAfter: { dispatchedAt: number; sentAt: number } | null = null;
  latency: LatencySample = { rttMs: 0, inputMs: 0, queueMs: 0, totalMs: 0, clockOffsetMs: 0 };
  status: ConnectionStatus = 'closed';

  connect(): void {
    this.closedByUs = false;
    this.open();
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }

  private open(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      this.startPing();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        this.onFrame(ev.data as ArrayBuffer);
        return;
      }
      this.onControl(JSON.parse(ev.data) as ServerMessage);
    };

    ws.onclose = () => {
      this.stopPing();
      this.ws = null;
      if (this.closedByUs) return this.setStatus('closed');
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      /* onclose always follows; nothing useful to do here */
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.setStatus('reconnecting');
    this.attempt++;
    // Exponential backoff with jitter so 20 clients reconnecting after a wifi
    // blip do not arrive as one synchronised thundering herd.
    const base = Math.min(250 * 2 ** (this.attempt - 1), MAX_BACKOFF_MS);
    const delay = base * (0.7 + Math.random() * 0.6);
    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = null;
      // Confirm the session still exists before reopening; otherwise we would
      // spin forever against a server that will keep refusing the upgrade.
      try {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (res.status === 401) return this.setStatus('unauthorized');
      } catch {
        /* server unreachable - keep retrying */
      }
      this.open();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    const ping = () => this.send({ type: 'ping', t: performance.timeOrigin + performance.now() });
    ping();
    this.pingTimer = window.setInterval(ping, 5000);
  }
  private stopPing(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private onControl(msg: ServerMessage): void {
    if (msg.type === 'pong' && msg.t !== undefined) {
      const now = performance.timeOrigin + performance.now();
      this.rttMs = now - msg.t;
      // Assume symmetric paths: server clock at the midpoint of the round trip.
      this.clockOffsetMs = msg.serverTime - (msg.t + this.rttMs / 2);
      this.latency = { ...this.latency, rttMs: Math.round(this.rttMs), clockOffsetMs: Math.round(this.clockOffsetMs) };
    }
    if (msg.type === 'input.ack' && this.lastInput && msg.eventId === this.lastInput.eventId) {
      const sentAt = this.lastInput.sentAt;
      const receivedLocal = msg.serverReceiveTime - this.clockOffsetMs;
      this.latency = {
        ...this.latency,
        inputMs: Math.max(0, Math.round(receivedLocal - sentAt)),
        queueMs: Math.round(msg.dispatchedAt - msg.serverReceiveTime),
      };
      // Now wait for the first frame captured after Chromium got the event: that
      // is the end-to-end number, measured entirely on the client clock.
      this.awaitingFrameAfter = { dispatchedAt: msg.dispatchedAt, sentAt };
    }
    for (const l of this.messageListeners) l(msg);
  }

  private onFrame(buf: ArrayBuffer): void {
    const decoded = decodeFrame(buf);
    if (!decoded) return;
    const { header, image } = decoded;
    const pending = this.awaitingFrameAfter;
    if (pending && header.capturedAt >= pending.dispatchedAt) {
      this.awaitingFrameAfter = null;
      const now = performance.timeOrigin + performance.now();
      this.latency = { ...this.latency, totalMs: Math.max(0, Math.round(now - pending.sentAt)) };
    }
    const listeners = this.frameListeners.get(header.tabId);
    if (!listeners) return;
    for (const l of listeners) l(header, image);
  }

  // --- sending -------------------------------------------------------------

  send(msg: ClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  /** Adds the event envelope (id + sequence) and tracks it for latency stats. */
  sendInput(msg: Record<string, unknown> & { type: string; tabId: string }): void {
    const eventId = `evt_${++this.eventCounter}_${Math.random().toString(36).slice(2, 8)}`;
    const sentAt = performance.timeOrigin + performance.now();
    const full = { ...msg, eventId, clientSequence: ++this.sequence, clientSentAt: sentAt } as unknown as ClientMessage;
    // Track discrete actions only: a mousemove ack tells us nothing a click does
    // not, and sampling keeps ack traffic proportionate.
    const isMove = msg.type === 'input.mouse' && msg.event === 'mousemove';
    if (!isMove) this.lastInput = { eventId, sentAt };
    this.send(full);
  }

  onFrames(tabId: string, listener: FrameListener): () => void {
    const set = this.frameListeners.get(tabId) ?? new Set<FrameListener>();
    this.frameListeners.set(tabId, set);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.frameListeners.delete(tabId);
    };
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  close(): void {
    this.closedByUs = true;
    this.stopPing();
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}
