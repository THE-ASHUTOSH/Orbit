/**
 * DOM KeyboardEvent -> CDP Input.dispatchKeyEvent.
 *
 * Sending ASCII is not enough: Chromium decides *editing behaviour* from
 * windowsVirtualKeyCode, not from `key`. Without a virtual key code Enter does
 * not submit, Backspace does not delete and arrows do not move the caret.
 * Conversely, printable characters need `text`; a key with no text must be sent
 * as `rawKeyDown` or Chromium inserts nothing.
 */

interface KeyDef {
  vk: number;
  /** Text inserted on keyDown, when the key produces any. */
  text?: string;
  /** Chromium treats these as keypad keys. */
  keypad?: boolean;
}

/** Non-printable and special keys, addressed by DOM `key`. */
const BY_KEY: Record<string, KeyDef> = {
  Backspace: { vk: 8 },
  Tab: { vk: 9, text: '\t' },
  Enter: { vk: 13, text: '\r' },
  ShiftLeft: { vk: 16 },
  Shift: { vk: 16 },
  Control: { vk: 17 },
  Alt: { vk: 18 },
  Pause: { vk: 19 },
  CapsLock: { vk: 20 },
  Escape: { vk: 27 },
  ' ': { vk: 32, text: ' ' },
  PageUp: { vk: 33 },
  PageDown: { vk: 34 },
  End: { vk: 35 },
  Home: { vk: 36 },
  ArrowLeft: { vk: 37 },
  ArrowUp: { vk: 38 },
  ArrowRight: { vk: 39 },
  ArrowDown: { vk: 40 },
  Insert: { vk: 45 },
  Delete: { vk: 46 },
  Meta: { vk: 91 },
  OS: { vk: 91 },
  ContextMenu: { vk: 93 },
  NumLock: { vk: 144 },
  ScrollLock: { vk: 145 },
  PrintScreen: { vk: 44 },
};

for (let i = 1; i <= 24; i++) BY_KEY[`F${i}`] = { vk: 111 + i };

/** Punctuation, addressed by DOM `code` so layout shifts do not break it. */
const BY_CODE: Record<string, number> = {
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  NumpadDivide: 111,
  NumpadMultiply: 106,
  NumpadSubtract: 109,
  NumpadAdd: 107,
  NumpadDecimal: 110,
  NumpadEnter: 13,
};

export interface CdpKeyEvent {
  type: 'keyDown' | 'keyUp' | 'rawKeyDown';
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  modifiers: number;
  location: number;
  autoRepeat: boolean;
  isKeypad: boolean;
  text?: string;
  unmodifiedText?: string;
}

const CTRL_ALT_META = 1 | 2 | 4; // alt|ctrl|meta

/**
 * `key` is the DOM key value, `code` the physical key. `modifiers` is the
 * Chromium bitmask (alt=1 ctrl=2 meta=4 shift=8).
 */
export function toCdpKeyEvent(input: {
  event: 'keydown' | 'keyup';
  key: string;
  code: string;
  location: number;
  repeat: boolean;
  modifiers: number;
}): CdpKeyEvent {
  const { key, code, modifiers } = input;
  const special = BY_KEY[key] ?? (key.length > 1 ? BY_KEY[code] : undefined);
  const printable = key.length === 1;

  let vk = special?.vk ?? 0;
  let text = special?.text;

  if (printable) {
    const upper = key.toUpperCase();
    if (/^[0-9]$/.test(key)) vk = key.charCodeAt(0);
    else if (/^[A-Z]$/.test(upper)) vk = upper.charCodeAt(0);
    else vk = BY_CODE[code] ?? 0;
    if (/^Numpad[0-9]$/.test(code)) vk = 96 + Number(code.slice(6));
    text = key;
  } else if (vk === 0) {
    vk = BY_CODE[code] ?? 0;
  }

  // Shortcuts must stay shortcuts: with ctrl/alt/meta held, text would make
  // Chromium insert a character *and* run the accelerator.
  if (modifiers & CTRL_ALT_META) text = undefined;

  const isDown = input.event === 'keydown';
  return {
    // rawKeyDown for anything that inserts nothing - Chromium ignores keyDown
    // without text for editing keys in some paths.
    type: isDown ? (text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
    location: input.location,
    autoRepeat: input.repeat,
    isKeypad: input.location === 3 || special?.keypad === true,
    ...(isDown && text ? { text, unmodifiedText: printable ? key.toLowerCase() : text } : {}),
  };
}
