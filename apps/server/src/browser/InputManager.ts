/**
 * The Input Arbiter.
 *
 * Chromium processes input for a page sequentially, so "two users typing in the
 * same tab at the same time" has to mean: both users' events are accepted
 * concurrently, and the SERVER decides one authoritative order. Each tab gets a
 * FIFO queue drained by a single worker; arrival order at the server is the
 * order Chromium sees. No user ever has to take a lock on a tab.
 *
 * Two things keep this responsive under load:
 *  - mousemove coalescing per (tab, user): a move still queued is overwritten
 *    rather than appended, so a slow drain cannot build a stale backlog.
 *  - de-duplication by eventId/clientSequence, so a client that retries after a
 *    reconnect cannot double-click or double-type.
 */
import { log } from '../log.js';
import type { AnyInputMessage } from '@orbit/protocol';
import type { CdpConnection } from './cdp.js';
import type { Tab, TabManager } from './TabManager.js';
import { toCdpKeyEvent } from './keymap.js';

export interface QueuedEvent {
  /** Authoritative per-tab ordering, assigned on arrival. */
  sequenceNumber: number;
  eventId: string;
  clientSequence: number;
  userId: string;
  tabId: string;
  eventType: string;
  serverReceiveTime: number;
  payload: AnyInputMessage;
}

export interface DispatchResult {
  eventId: string;
  tabId: string;
  serverReceiveTime: number;
  dispatchedAt: number;
  queueDepth: number;
}

const DEDUP_WINDOW = 1024;

export class InputManager {
  private queues = new Map<string, QueuedEvent[]>();
  private draining = new Set<string>();
  private sequence = new Map<string, number>();
  private seenIds = new Set<string>();
  private seenOrder: string[] = [];
  private lastClientSeq = new Map<string, number>();
  /** Rolling window of receive->dispatch latencies for the metrics endpoint. */
  private dispatchLatencies: number[] = [];
  /** Last user to send input to each tab, for attributing popups they opened. */
  private lastActorByTab = new Map<string, { userId: string; at: number }>();
  private dropped = 0;

  constructor(
    private readonly tabs: TabManager,
    private cdp: () => CdpConnection,
    private readonly onDispatched: (r: DispatchResult) => void,
  ) {}

  get totalQueueDepth(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }
  get droppedEvents(): number {
    return this.dropped;
  }

  percentiles(): { p50: number; p95: number } {
    if (this.dispatchLatencies.length === 0) return { p50: 0, p95: 0 };
    const s = [...this.dispatchLatencies].sort((a, b) => a - b);
    const at = (p: number) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]!;
    return { p50: at(0.5), p95: at(0.95) };
  }

  /**
   * Accept an input event. Returns false when it was a duplicate/replay.
   * `connectionKey` scopes clientSequence so two tabs open in one browser (two
   * connections for the same user) do not fight over the counter.
   */
  submit(msg: AnyInputMessage, userId: string, connectionKey: string): boolean {
    if (this.seenIds.has(msg.eventId)) return false;
    const seqKey = `${connectionKey}`;
    const last = this.lastClientSeq.get(seqKey);
    // clientSequence is monotonic per connection; anything not newer is a replay.
    if (last !== undefined && msg.clientSequence <= last && msg.clientSequence !== 0) return false;
    this.lastClientSeq.set(seqKey, msg.clientSequence);

    this.lastActorByTab.set(msg.tabId, { userId, at: Date.now() });
    this.seenIds.add(msg.eventId);
    this.seenOrder.push(msg.eventId);
    if (this.seenOrder.length > DEDUP_WINDOW) {
      const old = this.seenOrder.shift()!;
      this.seenIds.delete(old);
    }

    const tabId = msg.tabId;
    const q = this.queues.get(tabId) ?? [];
    if (!this.queues.has(tabId)) this.queues.set(tabId, q);

    const seq = (this.sequence.get(tabId) ?? 0) + 1;
    this.sequence.set(tabId, seq);

    const event: QueuedEvent = {
      sequenceNumber: seq,
      eventId: msg.eventId,
      clientSequence: msg.clientSequence,
      userId,
      tabId,
      eventType: msg.type === 'input.mouse' ? msg.event : msg.type === 'input.keyboard' ? msg.event : msg.type,
      serverReceiveTime: Date.now(),
      payload: msg,
    };

    // Coalesce: replace this user's still-queued mousemove instead of appending.
    if (msg.type === 'input.mouse' && msg.event === 'mousemove') {
      const idx = q.findIndex(
        (e) => e.userId === userId && e.payload.type === 'input.mouse' && e.payload.event === 'mousemove',
      );
      if (idx >= 0) {
        q[idx] = event;
        this.dropped++;
        void this.drain(tabId);
        return true;
      }
    }

    q.push(event);
    void this.drain(tabId);
    return true;
  }

  private async drain(tabId: string): Promise<void> {
    if (this.draining.has(tabId)) return;
    this.draining.add(tabId);
    try {
      const q = this.queues.get(tabId);
      while (q && q.length) {
        const event = q.shift()!;
        try {
          const tab = this.tabs.get(tabId);
          if (!tab || !tab.sessionId) continue; // tab closed under us
          this.dispatch(tab, event);
          const dispatchedAt = Date.now();
          const latency = dispatchedAt - event.serverReceiveTime;
          this.dispatchLatencies.push(latency);
          if (this.dispatchLatencies.length > 500) this.dispatchLatencies.shift();
          this.onDispatched({
            eventId: event.eventId,
            tabId,
            serverReceiveTime: event.serverReceiveTime,
            dispatchedAt,
            queueDepth: q.length,
          });
        } catch (err) {
          log.warn('input dispatch failed', { tabId, userId: event.userId, err: err as Error });
        }
        // Yield every so often so a burst cannot starve frames or heartbeats.
        if (q.length && q.length % 32 === 0) await new Promise((r) => setImmediate(r));
      }
    } finally {
      this.draining.delete(tabId);
    }
  }

  /**
   * Fire-and-forget over the CDP socket. Messages on one socket are processed
   * by Chromium in send order, so ordering is preserved without paying a
   * round-trip per event - which is the difference between ~5ms and ~15ms of
   * added input latency.
   */
  private dispatch(tab: Tab, event: QueuedEvent): void {
    const cdp = this.cdp();
    const s = tab.sessionId;
    const m = event.payload;
    const ts = event.serverReceiveTime / 1000; // CDP wants seconds

    switch (m.type) {
      case 'input.mouse': {
        const x = clamp(m.x, 0, tab.width);
        const y = clamp(m.y, 0, tab.height);
        const type =
          m.event === 'mousemove'
            ? 'mouseMoved'
            : m.event === 'mousedown'
              ? 'mousePressed'
              : m.event === 'mouseup'
                ? 'mouseReleased'
                : 'mouseWheel';
        cdp.post(
          'Input.dispatchMouseEvent',
          {
            type,
            x,
            y,
            button: m.button,
            buttons: m.buttons,
            clickCount: m.clickCount,
            modifiers: m.modifiers,
            timestamp: ts,
            ...(type === 'mouseWheel' ? { deltaX: m.deltaX, deltaY: m.deltaY } : {}),
            pointerType: 'mouse',
          },
          s,
        );
        return;
      }
      case 'input.keyboard': {
        cdp.post('Input.dispatchKeyEvent', { ...toCdpKeyEvent(m), timestamp: ts }, s);
        return;
      }
      case 'input.text': {
        // Committed IME composition, paste, or mobile autocomplete: one atomic
        // insert instead of synthesising per-character key events.
        cdp.post('Input.insertText', { text: m.text }, s);
        return;
      }
      case 'input.touch': {
        const type =
          m.event === 'touchstart'
            ? 'touchStart'
            : m.event === 'touchmove'
              ? 'touchMove'
              : m.event === 'touchend'
                ? 'touchEnd'
                : 'touchCancel';
        cdp.post(
          'Input.dispatchTouchEvent',
          {
            type,
            touchPoints: m.touches.map((t) => ({
              x: clamp(t.x, 0, tab.width),
              y: clamp(t.y, 0, tab.height),
              id: t.id,
            })),
            modifiers: m.modifiers,
            timestamp: ts,
          },
          s,
        );
        return;
      }
    }
  }

  /** Text insertion used by clipboard paste; goes through the same queue. */
  insertText(tab: Tab, text: string): void {
    this.cdp().post('Input.insertText', { text }, tab.sessionId);
  }

  /**
   * Who was last interacting with a tab. Used to decide whose screen should
   * follow a popup that tab opened - a click is the only evidence available.
   */
  /**
   * Everyone who has sent input to any tab recently, most recent first.
   *
   * Used to attribute a tab that Chromium opened with no opener and no
   * requester - an extension acting on its own. Attribution then only happens
   * when exactly one person has been active, so a guess is never made while two
   * people are working.
   */
  recentActors(withinMs = 15_000): string[] {
    const now = Date.now();
    const seen = new Map<string, number>();
    for (const { userId, at } of this.lastActorByTab.values()) {
      if (now - at > withinMs) continue;
      seen.set(userId, Math.max(seen.get(userId) ?? 0, at));
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([userId]) => userId);
  }

  lastActor(tabId: string, withinMs = 10_000): string | null {
    const entry = this.lastActorByTab.get(tabId);
    return entry && Date.now() - entry.at <= withinMs ? entry.userId : null;
  }

  dropTab(tabId: string): void {
    this.lastActorByTab.delete(tabId);
    this.queues.delete(tabId);
    this.sequence.delete(tabId);
    this.draining.delete(tabId);
  }

  /** After a browser restart the old CDP connection is gone. */
  rebind(cdp: () => CdpConnection): void {
    this.cdp = cdp;
    this.queues.clear();
    this.draining.clear();
  }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
