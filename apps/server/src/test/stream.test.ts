/**
 * Backpressure and pacing, with a fake CDP connection: a slow client must lose
 * frames rather than accumulate a queue of stale ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { decodeFrame } from '@orbit/protocol';
import { StreamManager, type FrameSink } from '../browser/StreamManager.js';
import { config } from '../config.js';

class FakeCdp extends EventEmitter {
  connected = true;
  sent: { method: string; sessionId?: string }[] = [];
  async send(method: string, _params?: unknown, sessionId?: string) {
    this.sent.push({ method, sessionId });
    return {} as never;
  }
  post(method: string, _params?: unknown, sessionId?: string) {
    this.sent.push({ method, sessionId });
  }
}

function fakeTabs(tabId = 'tab_01A', sessionId = 'sess-1') {
  const tab = { tabId, sessionId, width: 800, height: 600 };
  return {
    tab,
    manager: {
      require: () => tab,
      get: () => tab,
      tabForSession: (s: string) => (s === sessionId ? tab : undefined),
    } as never,
  };
}

function sink(id: string, buffered = () => 0): FrameSink & { received: Uint8Array[] } {
  const received: Uint8Array[] = [];
  return {
    id,
    userId: `user_${id}`,
    received,
    send: (d) => received.push(d),
    bufferedAmount: buffered,
    isOpen: () => true,
  };
}

const frameEvent = (sessionId: string) => ({
  method: 'Page.screencastFrame',
  sessionId,
  params: {
    data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
    sessionId: 7,
    metadata: { deviceWidth: 800, deviceHeight: 600, scrollOffsetX: 0, scrollOffsetY: 40, timestamp: 1_700_000 },
  },
});

test('stream: subscribing starts one screencast and frames reach the subscriber', async () => {
  const cdp = new FakeCdp();
  const { manager } = fakeTabs();
  const streams = new StreamManager(manager);
  streams.attach(cdp as never);
  const a = sink('a');
  await streams.subscribe('tab_01A', a);

  assert.ok(cdp.sent.some((s) => s.method === 'Page.startScreencast'));
  cdp.emit('Page.screencastFrame', frameEvent('sess-1'));
  assert.equal(a.received.length, 1);
  const decoded = decodeFrame(a.received[0]!.slice().buffer as ArrayBuffer);
  assert.equal(decoded?.header.tabId, 'tab_01A');
  assert.equal(decoded?.header.scrollY, 40);
  assert.equal(decoded?.image.length, 4);
});

test('stream: every frame is acked so Chromium keeps producing', async () => {
  const cdp = new FakeCdp();
  const streams = new StreamManager(fakeTabs().manager);
  streams.attach(cdp as never);
  await streams.subscribe('tab_01A', sink('a'));
  cdp.sent.length = 0;
  cdp.emit('Page.screencastFrame', frameEvent('sess-1'));
  assert.ok(cdp.sent.some((s) => s.method === 'Page.screencastFrameAck'), 'first frame acked immediately');
});

test('stream: a backed-up client is skipped, a healthy one is not', async () => {
  const cdp = new FakeCdp();
  const streams = new StreamManager(fakeTabs().manager);
  streams.attach(cdp as never);
  const fast = sink('fast');
  const slow = sink('slow', () => config.backpressureBytes + 1);
  await streams.subscribe('tab_01A', fast);
  await streams.subscribe('tab_01A', slow);

  for (let i = 0; i < 5; i++) cdp.emit('Page.screencastFrame', frameEvent('sess-1'));
  assert.equal(fast.received.length, 5);
  assert.equal(slow.received.length, 0, 'stale frames are dropped, never queued');
  assert.ok(streams.rates().dropped >= 5);
});

test('stream: the screencast stops when the last subscriber leaves', async () => {
  const cdp = new FakeCdp();
  const streams = new StreamManager(fakeTabs().manager);
  streams.attach(cdp as never);
  const a = sink('a');
  const b = sink('b');
  await streams.subscribe('tab_01A', a);
  await streams.subscribe('tab_01A', b);
  streams.unsubscribe('tab_01A', a.id);
  assert.equal(cdp.sent.filter((s) => s.method === 'Page.stopScreencast').length, 0, 'still one viewer');
  streams.unsubscribe('tab_01A', b.id);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cdp.sent.filter((s) => s.method === 'Page.stopScreencast').length, 1);
});

test('stream: viewers are reported per tab', async () => {
  const cdp = new FakeCdp();
  const streams = new StreamManager(fakeTabs().manager);
  streams.attach(cdp as never);
  await streams.subscribe('tab_01A', sink('a'));
  assert.deepEqual(streams.viewers('tab_01A'), ['user_a']);
  assert.equal(streams.subscriberCount('tab_01A'), 1);
  assert.deepEqual(streams.viewers('tab_01OTHER'), []);
});
