import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOD, remoteModifiers, shortcutForKey } from '@orbit/protocol';
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

// --- accelerators ----------------------------------------------------------

test('keymap: Ctrl+C, Ctrl+V, Ctrl+X and Ctrl+A carry the editing command', () => {
  /**
   * The regression this pins: a key event alone does nothing for these.
   * Chromium resolves them in the browser process from real OS input, so an
   * injected event needs `commands` or the page never copies, pastes or selects.
   */
  const chord = (code: string, modifiers: number = MOD.ctrl) =>
    toCdpKeyEvent({ event: 'keydown', key: code.slice(3).toLowerCase(), code, location: 0, repeat: false, modifiers });

  assert.deepEqual(chord('KeyC').commands, ['copy']);
  assert.deepEqual(chord('KeyV').commands, ['paste']);
  assert.deepEqual(chord('KeyX').commands, ['cut']);
  assert.deepEqual(chord('KeyA').commands, ['selectAll']);
  assert.deepEqual(chord('KeyZ').commands, ['undo']);
  assert.deepEqual(chord('KeyZ', MOD.ctrl | MOD.shift).commands, ['redo'], 'Shift+Ctrl+Z is redo');
  // No text with a modifier held: a command must not also type a letter.
  assert.equal(chord('KeyC').text, undefined);
});

test('keymap: an editing command is sent once, on the way down only', () => {
  const up = toCdpKeyEvent({ event: 'keyup', key: 'c', code: 'KeyC', location: 0, repeat: false, modifiers: MOD.ctrl });
  assert.equal(up.commands, undefined, 'a command on key-up would copy twice');
});

test('keymap: a letter with no Ctrl, or with Alt or Meta, is not an editing command', () => {
  const plain = (modifiers: number) =>
    toCdpKeyEvent({ event: 'keydown', key: 'c', code: 'KeyC', location: 0, repeat: false, modifiers });
  assert.equal(plain(0).commands, undefined);
  assert.equal(plain(MOD.alt).commands, undefined);
  // Meta is the Super key on the remote Linux browser, not an accelerator.
  assert.equal(plain(MOD.meta).commands, undefined);
  assert.equal(plain(MOD.ctrl | MOD.alt).commands, undefined, 'Ctrl+Alt+C is not a copy');
});

test('modifiers: a Mac viewer\'s Command becomes Ctrl for the remote browser', () => {
  const cmdC = { altKey: false, ctrlKey: false, metaKey: true, shiftKey: false };
  // On a Mac, Command means "accelerator"; the browser being driven is Linux,
  // where Meta is the Super key and does nothing.
  assert.equal(remoteModifiers(cmdC, true), MOD.ctrl);
  assert.equal(remoteModifiers(cmdC, false), MOD.meta, 'elsewhere Meta stays Meta');
  // Other modifiers ride along untouched.
  assert.equal(
    remoteModifiers({ altKey: false, ctrlKey: false, metaKey: true, shiftKey: true }, true),
    MOD.ctrl | MOD.shift,
  );
  assert.equal(
    remoteModifiers({ altKey: false, ctrlKey: true, metaKey: true, shiftKey: false }, true),
    MOD.ctrl,
    'Ctrl+Command collapses to one Ctrl',
  );
});

test('shortcuts: Alt chords are matched by physical key, so they work on macOS', () => {
  // What a Mac actually delivers: Option+T is "†", Option+W "∑", Option+1 "¡".
  assert.equal(shortcutForKey({ code: 'KeyT', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }), 'newTab');
  assert.equal(
    shortcutForKey({ code: 'KeyT', altKey: true, ctrlKey: false, metaKey: false, shiftKey: true }),
    'reopenTab',
  );
  assert.equal(shortcutForKey({ code: 'KeyW', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }), 'closeTab');
  assert.equal(
    shortcutForKey({ code: 'KeyD', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }),
    'focusAddress',
  );
  assert.equal(
    shortcutForKey({ code: 'Digit3', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }),
    'selectTab:3',
  );
  assert.equal(shortcutForKey({ code: 'ArrowLeft', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }), 'back');
  // The way out of keyboard capture: while captured, this browser's own chords
  // are exactly what is unavailable, so this one must not depend on `key` either.
  assert.equal(
    shortcutForKey({ code: 'KeyK', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }),
    'toggleCapture',
  );
  // Full screen is on Alt+F, not F11: F11 belongs to the host browser.
  assert.equal(
    shortcutForKey({ code: 'KeyF', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }),
    'toggleFullscreen',
  );
});

test('shortcuts: nothing without Alt, and nothing when Ctrl or Command is also held', () => {
  assert.equal(shortcutForKey({ code: 'KeyT', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }), null);
  assert.equal(shortcutForKey({ code: 'KeyT', altKey: true, ctrlKey: true, metaKey: false, shiftKey: false }), null);
  assert.equal(shortcutForKey({ code: 'KeyT', altKey: true, ctrlKey: false, metaKey: true, shiftKey: false }), null);
  assert.equal(shortcutForKey({ code: 'KeyQ', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }), null);
});
