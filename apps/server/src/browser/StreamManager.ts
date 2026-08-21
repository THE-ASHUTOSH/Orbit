/**
 * Per-tab video: CDP Page.startScreencast -> binary WebSocket frames.
 *
 * Why this and not WebRTC-over-desktop-capture (see docs/decisions.md):
 * screencast is scoped to a single *page target*, which is exactly the product's
 * unit of collaboration. Four users on four tabs are four independent streams
 * from one Chromium, with no compositor, no window manager and no cropping of a
 * shared desktop image.
 *
 * Frame pacing is done by *delaying the ack*: Chromium will not produce the next
 * frame until the previous one is acked, so a late ack throttles capture at the
 * source and costs nothing in CPU - unlike capturing at 60fps and discarding.
 */
import { encodeFrame, type FrameHeader } from '@orbit/protocol';
import { config } from '../config.js';
import { log } from '../log.js';
import type { CdpConnection, CdpEvent } from './cdp.js';
import type { Tab, TabManager } from './TabManager.js';

/** A client that can receive frames. Implemented by the WebSocket connection. */
export interface FrameSink {
  id: string;
  userId: string;
  send(data: Uint8Array): void;
  /** Bytes still queued in the socket; the backpressure signal. */
  bufferedAmount(): number;
  isOpen(): boolean;
}

interface StreamState {
  tabId: string;
  sinks: Map<string, FrameSink>;
  seq: number;
  lastFrameAt: number;
  pendingAck: NodeJS.Timeout | null;
  active: boolean;
}

export class StreamManager {
  private streams = new Map<string, StreamState>();
  private cdp: CdpConnection | null = null;
  private frameCount = 0;
  private byteCount = 0;
  private droppedFrames = 0;
  private windowStart = Date.now();
  private lastRates = { fps: 0, bps: 0 };

  constructor(private readonly tabs: TabManager) {}

  attach(cdp: CdpConnection): void {
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (e: CdpEvent) => this.onFrame(e));
    // Re-arm streams after a restart. Sinks belonging to connections that died
    // while the browser was down are dropped here rather than lingering until
    // the next frame, so a tab with no live viewer does not keep capturing.
    for (const state of this.streams.values()) {
      state.active = false;
      for (const [id, sink] of state.sinks) if (!sink.isOpen()) state.sinks.delete(id);
      if (state.sinks.size) void this.ensureStarted(state.tabId);
      else void this.stop(state.tabId, 'no live subscribers after restart');
    }
  }

  subscriberCount(tabId: string): number {
    return this.streams.get(tabId)?.sinks.size ?? 0;
  }

  viewers(tabId: string): string[] {
    const s = this.streams.get(tabId);
    return s ? [...new Set([...s.sinks.values()].map((k) => k.userId))] : [];
  }

  async subscribe(tabId: string, sink: FrameSink): Promise<{ width: number; height: number }> {
    const tab = this.tabs.require(tabId);
    let state = this.streams.get(tabId);
    if (!state) {
      state = { tabId, sinks: new Map(), seq: 0, lastFrameAt: 0, pendingAck: null, active: false };
      this.streams.set(tabId, state);
    }
    state.sinks.set(sink.id, sink);
    await this.ensureStarted(tabId);
    // Screencast frames are repaint-driven: a quiet page emits one frame when the
    // stream starts and then nothing at all. Every subscriber therefore gets an
    // explicit keyframe, unconditionally - the alternative is a blank canvas
    // whenever the page happens to be still, which is exactly the state a tab is
    // in right after crash recovery or when a second person joins a static page.
    await this.sendKeyframe(tabId, sink);
    return { width: tab.width, height: tab.height };
  }

  unsubscribe(tabId: string, sinkId: string): void {
    const state = this.streams.get(tabId);
    if (!state) return;
    state.sinks.delete(sinkId);
    // Nobody watching: stop capturing. This is the difference between an idle
    // server and one burning a core per open tab.
    if (state.sinks.size === 0) void this.stop(tabId);
  }

  unsubscribeAll(sinkId: string): void {
    for (const tabId of [...this.streams.keys()]) this.unsubscribe(tabId, sinkId);
  }

  /**
   * One-off full JPEG for a single sink, outside the screencast cadence.
   *
   * Retried once: right after a browser restart the page session can be a
   * moment away from being able to answer, and this is the only frame a
   * subscriber to a motionless page is going to get.
   */
  private async sendKeyframe(tabId: string, sink: FrameSink, attempt = 0): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab?.sessionId || !this.cdp?.connected) return;
    try {
      const { data } = await this.cdp.send<{ data: string }>(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: config.streamQuality, captureBeyondViewport: false },
        tab.sessionId,
        5000,
      );
      const state = this.streams.get(tabId);
      if (!state || !sink.isOpen()) return;
      const image = Buffer.from(data, 'base64');
      sink.send(
        encodeFrame(
          {
            tabId,
            seq: ++state.seq,
            width: tab.width,
            height: tab.height,
            scrollX: 0,
            scrollY: 0,
            capturedAt: Date.now(),
            sentAt: Date.now(),
            format: 'jpeg',
          },
          image,
        ),
      );
      this.frameCount++;
      this.byteCount += image.byteLength;
    } catch (err) {
      if (attempt < 1 && sink.isOpen()) {
        await new Promise((r) => setTimeout(r, 400));
        return this.sendKeyframe(tabId, sink, attempt + 1);
      }
      log.warn('keyframe capture failed', { tabId, err: err as Error });
    }
  }

  private async ensureStarted(tabId: string): Promise<void> {
    const state = this.streams.get(tabId);
    if (!state || state.active || !this.cdp?.connected) return;
    let tab: Tab;
    try {
      tab = this.tabs.require(tabId);
    } catch {
      return;
    }
    state.active = true;
    try {
      await this.cdp.send(
        'Page.startScreencast',
        {
          format: 'jpeg',
          quality: config.streamQuality,
          maxWidth: tab.width,
          maxHeight: tab.height,
          everyNthFrame: 1,
        },
        tab.sessionId,
      );
      log.info('stream started', { tabId, width: tab.width, height: tab.height, quality: config.streamQuality });
    } catch (err) {
      state.active = false;
      log.warn('failed to start screencast', { tabId, err: err as Error });
    }
  }

  async stop(tabId: string, reason = 'no subscribers'): Promise<void> {
    const state = this.streams.get(tabId);
    if (!state) return;
    if (state.pendingAck) clearTimeout(state.pendingAck);
    state.pendingAck = null;
    const wasActive = state.active;
    state.active = false;
    this.streams.delete(tabId);
    if (!wasActive || !this.cdp?.connected) return;
    const tab = this.tabs.get(tabId);
    if (!tab?.sessionId) return;
    await this.cdp.send('Page.stopScreencast', {}, tab.sessionId).catch(() => {});
    log.info('stream stopped', { tabId, reason });
  }

  /** Viewport change: screencast must be restarted to pick up the new size. */
  async restart(tabId: string): Promise<void> {
    const state = this.streams.get(tabId);
    if (!state?.sinks.size) return;
    const sinks = new Map(state.sinks);
    await this.stop(tabId, 'resize');
    const fresh: StreamState = { tabId, sinks, seq: state.seq, lastFrameAt: 0, pendingAck: null, active: false };
    this.streams.set(tabId, fresh);
    await this.ensureStarted(tabId);
  }

  private onFrame(e: CdpEvent): void {
    const frameSessionId = e.params.sessionId as number;
    const pageSession = e.sessionId!;
    const tab = this.tabs.tabForSession(pageSession);
    if (!tab) return;
    const state = this.streams.get(tab.tabId);

    const ack = () => this.cdp?.post('Page.screencastFrameAck', { sessionId: frameSessionId }, pageSession);

    if (!state || state.sinks.size === 0) {
      ack();
      return;
    }

    const image = Buffer.from(e.params.data as string, 'base64');
    const md = e.params.metadata ?? {};
    const header: FrameHeader = {
      tabId: tab.tabId,
      seq: ++state.seq,
      width: md.deviceWidth ?? tab.width,
      height: md.deviceHeight ?? tab.height,
      scrollX: md.scrollOffsetX ?? 0,
      scrollY: md.scrollOffsetY ?? 0,
      capturedAt: md.timestamp ? Math.round(md.timestamp * 1000) : Date.now(),
      sentAt: Date.now(),
      format: 'jpeg',
    };
    const packet = encodeFrame(header, image);

    for (const sink of state.sinks.values()) {
      if (!sink.isOpen()) {
        state.sinks.delete(sink.id);
        continue;
      }
      // Backpressure: a client that cannot keep up gets the NEXT frame instead
      // of an ever-growing queue of stale ones. For interactive video a dropped
      // frame is always better than a late frame.
      if (sink.bufferedAmount() > config.backpressureBytes) {
        this.droppedFrames++;
        continue;
      }
      sink.send(packet);
      this.byteCount += packet.byteLength;
    }
    this.frameCount++;

    // Pace the next capture by holding the ack.
    const minInterval = 1000 / Math.max(1, config.maxFps);
    const since = Date.now() - state.lastFrameAt;
    state.lastFrameAt = Date.now();
    if (since >= minInterval) ack();
    else state.pendingAck = setTimeout(ack, Math.ceil(minInterval - since));
  }

  /** Rolling throughput, sampled by the metrics loop. */
  rates(): { fps: number; bps: number; dropped: number } {
    const elapsed = (Date.now() - this.windowStart) / 1000;
    if (elapsed >= 1) {
      this.lastRates = { fps: this.frameCount / elapsed, bps: this.byteCount / elapsed };
      this.frameCount = 0;
      this.byteCount = 0;
      this.windowStart = Date.now();
    }
    return { fps: this.lastRates.fps, bps: this.lastRates.bps, dropped: this.droppedFrames };
  }

  async stopAll(): Promise<void> {
    for (const tabId of [...this.streams.keys()]) await this.stop(tabId, 'shutdown');
  }
}
