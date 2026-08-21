import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCdpKeyEvent } from '../browser/keymap.js';

const down = (over: Partial<Parameters<typeof toCdpKeyEvent>[0]>) =>
  toCdpKeyEvent({ event: 'keydown', key: 'a', code: 'KeyA', location: 0, repeat: false, modifiers: 0, ...over });

test('keymap: printable characters carry text and a virtual key code', () => {
  const e = down({ key: 'a', code: 'KeyA' });
  assert.equal(e.type, 'keyDown');
  assert.equal(e.text, 'a');
  assert.equal(e.windowsVirtualKeyCode, 65);
});

test('keymap: shifted characters keep the typed text', () => {
  const e = down({ key: 'A', code: 'KeyA', modifiers: 8 });
  assert.equal(e.text, 'A');
  assert.equal(e.unmodifiedText, 'a');
  assert.equal(e.windowsVirtualKeyCode, 65);
});

test('keymap: Enter and Tab produce the control characters Chromium expects', () => {
  assert.equal(down({ key: 'Enter', code: 'Enter' }).text, '\r');
  assert.equal(down({ key: 'Enter', code: 'Enter' }).windowsVirtualKeyCode, 13);
  assert.equal(down({ key: 'Tab', code: 'Tab' }).text, '\t');
});

test('keymap: editing keys send rawKeyDown with no text', () => {
  for (const [key, vk] of [
    ['Backspace', 8],
    ['Delete', 46],
    ['ArrowLeft', 37],
    ['ArrowUp', 38],
    ['Escape', 27],
    ['Home', 36],
    ['F5', 116],
  ] as const) {
    const e = down({ key, code: key });
    assert.equal(e.windowsVirtualKeyCode, vk, `${key} virtual key code`);
    assert.equal(e.text, undefined, `${key} must not insert text`);
    assert.equal(e.type, 'rawKeyDown');
  }
});

test('keymap: shortcuts do not also insert their character', () => {
  const ctrlA = down({ key: 'a', code: 'KeyA', modifiers: 2 });
  assert.equal(ctrlA.text, undefined, 'ctrl+a must not type an "a"');
  assert.equal(ctrlA.windowsVirtualKeyCode, 65);
  assert.equal(down({ key: 'c', code: 'KeyC', modifiers: 4 }).text, undefined, 'meta+c must not type a "c"');
});

test('keymap: punctuation resolves through the physical code', () => {
  assert.equal(down({ key: '/', code: 'Slash' }).windowsVirtualKeyCode, 191);
  assert.equal(down({ key: ';', code: 'Semicolon' }).windowsVirtualKeyCode, 186);
});

test('keymap: numpad keys are flagged as keypad', () => {
  const e = down({ key: '5', code: 'Numpad5', location: 3 });
  assert.equal(e.isKeypad, true);
  assert.equal(e.windowsVirtualKeyCode, 101);
});

test('keymap: keyup never carries text', () => {
  const e = toCdpKeyEvent({ event: 'keyup', key: 'a', code: 'KeyA', location: 0, repeat: false, modifiers: 0 });
  assert.equal(e.type, 'keyUp');
  assert.equal(e.text, undefined);
});
