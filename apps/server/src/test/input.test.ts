/**
 * Arbiter behaviour: this is the file that proves the two headline multi-user
 * requirements - simultaneous users on DIFFERENT tabs never leak into each
 * other, and simultaneous users on the SAME tab get one deterministic order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputManager } from '../browser/InputManager.js';
import type { AnyInputMessage } from '@orbit/protocol';

interface Sent {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

function harness() {
  const sent: Sent[] = [];
  const tabs = new Map(
    ['tab_01A', 'tab_01B'].map((tabId, i) => [
      tabId,
      { tabId, sessionId: `session-${i}`, width: 1280, height: 720 },
    ]),
  );
  const fakeTabs = { get: (id: string) => tabs.get(id) } as never;
  const fakeCdp = () =>
    ({
      post: (method: string, params: Record<string, any>, sessionId?: string) => sent.push({ method, params, sessionId }),
    }) as never;
  const acks: string[] = [];
  const input = new InputManager(fakeTabs, fakeCdp, (r) => acks.push(r.eventId));
  return { input, sent, acks };
}

let seq = 0;
const mouse = (tabId: string, over: Partial<any> = {}): AnyInputMessage =>
  ({
    type: 'input.mouse',
    event: 'mousedown',
    eventId: `evt_${++seq}`,
    clientSequence: seq,
    tabId,
    x: 10,
    y: 20,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    deltaX: 0,
    deltaY: 0,
    modifiers: 0,
    ...over,
  }) as AnyInputMessage;

const key = (tabId: string, k: string, over: Partial<any> = {}): AnyInputMessage =>
  ({
    type: 'input.keyboard',
    event: 'keydown',
    eventId: `evt_${++seq}`,
    clientSequence: seq,
    tabId,
    key: k,
    code: `Key${k.toUpperCase()}`,
    location: 0,
    repeat: false,
    modifiers: 0,
    ...over,
  }) as AnyInputMessage;

const settle = () => new Promise((r) => setTimeout(r, 10));

test('input: events for one tab never reach another tab', async () => {
  const { input, sent } = harness();
  input.submit(key('tab_01A', 'a'), 'user_A', 'conn_A');
  input.submit(key('tab_01B', 'b'), 'user_B', 'conn_B');
  await settle();

  const toA = sent.filter((s) => s.sessionId === 'session-0');
  const toB = sent.filter((s) => s.sessionId === 'session-1');
  assert.equal(toA.length, 1);
  assert.equal(toB.length, 1);
  assert.equal(toA[0]!.params.text, 'a');
  assert.equal(toB[0]!.params.text, 'b');
});

test('input: three users on one tab are serialised in arrival order', async () => {
  const { input, sent } = harness();
  input.submit(key('tab_01A', 'x'), 'user_A', 'conn_A');
  input.submit(key('tab_01A', 'y'), 'user_B', 'conn_B');
  input.submit(key('tab_01A', 'z'), 'user_C', 'conn_C');
  await settle();

  assert.deepEqual(
    sent.map((s) => s.params.text),
    ['x', 'y', 'z'],
    'server arrival order is the authoritative order',
  );
  assert.ok(sent.every((s) => s.sessionId === 'session-0'));
});

test('input: duplicate eventId is dropped (retry after reconnect)', async () => {
  const { input, sent } = harness();
  const event = mouse('tab_01A');
  assert.equal(input.submit(event, 'user_A', 'conn_A'), true);
  assert.equal(input.submit(event, 'user_A', 'conn_A'), false, 'same eventId must not fire twice');
  await settle();
  assert.equal(sent.length, 1);
});

test('input: replayed clientSequence is dropped', async () => {
  const { input, sent } = harness();
  input.submit(mouse('tab_01A', { eventId: 'evt_s5', clientSequence: 5 }), 'user_A', 'conn_A');
  const stale = input.submit(mouse('tab_01A', { eventId: 'evt_s4', clientSequence: 4 }), 'user_A', 'conn_A');
  assert.equal(stale, false);
  await settle();
  assert.equal(sent.length, 1);
});

test('input: a second connection for the same user has its own sequence space', async () => {
  const { input, sent } = harness();
  input.submit(mouse('tab_01A', { eventId: 'evt_c1', clientSequence: 50 }), 'user_A', 'conn_1');
  const accepted = input.submit(mouse('tab_01A', { eventId: 'evt_c2', clientSequence: 1 }), 'user_A', 'conn_2');
  assert.equal(accepted, true, 'a fresh tab in the same browser must not be starved');
  await settle();
  assert.equal(sent.length, 2);
});

test('input: mouse coordinates are clamped to the viewport', async () => {
  const { input, sent } = harness();
  input.submit(mouse('tab_01A', { x: 99999, y: -50 }), 'user_A', 'conn_A');
  await settle();
  assert.equal(sent[0]!.params.x, 1280);
  assert.equal(sent[0]!.params.y, 0);
});

test('input: text insertion is atomic (IME / paste path)', async () => {
  const { input, sent } = harness();
  input.submit(
    { type: 'input.text', eventId: 'evt_t', clientSequence: 1, tabId: 'tab_01A', text: '日本語テキスト' } as AnyInputMessage,
    'user_A',
    'conn_A',
  );
  await settle();
  assert.equal(sent[0]!.method, 'Input.insertText');
  assert.equal(sent[0]!.params.text, '日本語テキスト');
});

test('input: wheel and touch map to the right CDP domains', async () => {
  const { input, sent } = harness();
  input.submit(mouse('tab_01A', { event: 'wheel', deltaY: 120 }), 'user_A', 'conn_A');
  input.submit(
    {
      type: 'input.touch',
      event: 'touchstart',
      eventId: 'evt_touch',
      clientSequence: 999,
      tabId: 'tab_01A',
      touches: [{ id: 0, x: 5, y: 5 }],
      modifiers: 0,
    } as AnyInputMessage,
    'user_A',
    'conn_touch',
  );
  await settle();
  assert.equal(sent[0]!.params.type, 'mouseWheel');
  assert.equal(sent[0]!.params.deltaY, 120);
  assert.equal(sent[1]!.method, 'Input.dispatchTouchEvent');
  assert.equal(sent[1]!.params.type, 'touchStart');
});

test('input: every dispatched event is acked with timings', async () => {
  const { input, acks } = harness();
  input.submit(mouse('tab_01A', { eventId: 'evt_ack_1', clientSequence: 1001 }), 'user_A', 'conn_ack');
  await settle();
  assert.deepEqual(acks, ['evt_ack_1']);
  const p = input.percentiles();
  assert.ok(p.p50 >= 0 && p.p95 >= 0);
});

test('input: events for a closed tab are discarded, not dispatched', async () => {
  const { input, sent } = harness();
  input.submit(mouse('tab_01GONE', { tabId: 'tab_01GONE' }), 'user_A', 'conn_gone');
  await settle();
  assert.equal(sent.length, 0);
});
