import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientMessage, decodeFrame, encodeFrame, permits, userColor, type FrameHeader } from '@orbit/protocol';

test('protocol: frame envelope round-trips header and image bytes', () => {
  const header: FrameHeader = {
    tabId: 'tab_01ABC',
    seq: 42,
    width: 1280,
    height: 720,
    scrollX: 0,
    scrollY: 128,
    capturedAt: 1_700_000_000_000,
    sentAt: 1_700_000_000_005,
    format: 'jpeg',
  };
  const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const packet = encodeFrame(header, image);
  const decoded = decodeFrame(packet.slice().buffer as ArrayBuffer);
  assert.ok(decoded);
  assert.deepEqual(decoded.header, header);
  assert.deepEqual([...decoded.image], [...image]);
});

test('protocol: non-frame binary is rejected rather than misparsed', () => {
  assert.equal(decodeFrame(new Uint8Array([1, 2, 3, 4]).buffer), null);
  assert.equal(decodeFrame(new ArrayBuffer(2)), null);
});

test('protocol: malformed client messages are rejected', () => {
  assert.equal(ClientMessage.safeParse({ type: 'nope' }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'input.mouse' }).success, false, 'missing envelope');
  assert.equal(
    ClientMessage.safeParse({
      type: 'input.mouse',
      event: 'mousemove',
      eventId: 'evt_1',
      clientSequence: 0,
      tabId: 'not a tab id',
      x: 1,
      y: 1,
    }).success,
    false,
    'tab id shape is enforced',
  );
  assert.equal(
    ClientMessage.safeParse({
      type: 'input.keyboard',
      event: 'keydown',
      eventId: 'evt_1',
      clientSequence: 1,
      tabId: 'tab_01ABC',
      key: 'a',
      code: 'KeyA',
      modifiers: 99,
    }).success,
    false,
    'modifier bitmask is bounded',
  );
});

test('protocol: valid input messages parse and get defaults', () => {
  const parsed = ClientMessage.parse({
    type: 'input.mouse',
    event: 'mousedown',
    eventId: 'evt_1',
    clientSequence: 7,
    tabId: 'tab_01ABC',
    x: 10,
    y: 20,
  });
  assert.equal(parsed.type, 'input.mouse');
  if (parsed.type !== 'input.mouse') return;
  assert.equal(parsed.button, 'none');
  assert.equal(parsed.modifiers, 0);
});

test('protocol: permission ranking', () => {
  assert.ok(permits('admin', 'control'));
  assert.ok(permits('control', 'view'));
  assert.equal(permits('view', 'control'), false);
  assert.equal(permits(null, 'view'), false);
});

test('protocol: user colour is stable and deterministic', () => {
  assert.equal(userColor('user_abc'), userColor('user_abc'));
  assert.notEqual(userColor('user_abc'), userColor('user_xyz'));
});
