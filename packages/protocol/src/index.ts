/**
 * Wire protocol shared by server and web client.
 *
 * Everything the client can send is a zod schema: the server parses with it and
 * rejects on failure, so there is exactly one definition of the wire format and
 * the TypeScript types are derived from the validators rather than hand-written.
 *
 * Frames are NOT in here. They travel as binary WebSocket messages
 * (see encodeFrameHeader / FRAME_MAGIC below) because base64 in JSON costs 33%
 * bandwidth and a needless decode on the hot path.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Identifiers & primitives
// ---------------------------------------------------------------------------

/** Tabs/users/etc. always carry a stable prefixed id - never an array index. */
export const Id = z.string().min(3).max(64).regex(/^[a-z]+_[A-Za-z0-9_-]+$/);
export const TabId = Id;
export const UserId = Id;

export const Role = z.enum(['admin', 'user', 'viewer']);
export type Role = z.infer<typeof Role>;

export const TabPermission = z.enum(['view', 'control', 'admin']);
export type TabPermission = z.infer<typeof TabPermission>;

export const PresenceState = z.enum(['online', 'idle', 'reconnecting', 'disconnected']);
export type PresenceState = z.infer<typeof PresenceState>;

export const BrowserStatus = z.enum(['starting', 'running', 'restarting', 'crashed', 'stopped']);
export type BrowserStatus = z.infer<typeof BrowserStatus>;

/** Chromium modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export const Modifiers = z.number().int().min(0).max(15);

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/** Fields every input event carries so the server can order and de-duplicate. */
const inputEnvelope = {
  eventId: z.string().min(1).max(64),
  /** Monotonic per connection. Lets the server drop replayed events. */
  clientSequence: z.number().int().nonnegative(),
  /** Client clock, used only for latency reporting - never for ordering. */
  clientSentAt: z.number().nonnegative().optional(),
  tabId: TabId,
};

export const MouseEventMessage = z.object({
  type: z.literal('input.mouse'),
  ...inputEnvelope,
  event: z.enum(['mousemove', 'mousedown', 'mouseup', 'wheel']),
  x: z.number().finite(),
  y: z.number().finite(),
  button: z.enum(['none', 'left', 'middle', 'right', 'back', 'forward']).default('none'),
  buttons: z.number().int().min(0).max(31).default(0),
  clickCount: z.number().int().min(0).max(3).default(0),
  deltaX: z.number().finite().default(0),
  deltaY: z.number().finite().default(0),
  modifiers: Modifiers.default(0),
});

export const KeyboardEventMessage = z.object({
  type: z.literal('input.keyboard'),
  ...inputEnvelope,
  event: z.enum(['keydown', 'keyup']),
  key: z.string().max(32),
  code: z.string().max(32),
  /** DOM KeyboardEvent.location - distinguishes left/right modifiers, numpad. */
  location: z.number().int().min(0).max(3).default(0),
  repeat: z.boolean().default(false),
  modifiers: Modifiers.default(0),
});

/** Committed IME composition or pasted text. Bypasses per-key synthesis. */
export const TextInputMessage = z.object({
  type: z.literal('input.text'),
  ...inputEnvelope,
  text: z.string().max(8192),
});

export const TouchEventMessage = z.object({
  type: z.literal('input.touch'),
  ...inputEnvelope,
  event: z.enum(['touchstart', 'touchmove', 'touchend', 'touchcancel']),
  touches: z
    .array(
      z.object({
        id: z.number().int().nonnegative(),
        x: z.number().finite(),
        y: z.number().finite(),
      }),
    )
    .max(10),
  modifiers: Modifiers.default(0),
});

/** Cursor telemetry for the multi-user cursor overlay. Never touches Chromium. */
export const CursorMessage = z.object({
  type: z.literal('cursor'),
  tabId: TabId,
  x: z.number().finite(),
  y: z.number().finite(),
  active: z.boolean().default(true),
});

export const SubscribeTabMessage = z.object({
  type: z.literal('tab.subscribe'),
  tabId: TabId,
  /** Client viewport in CSS px; server picks the stream size from it. */
  width: z.number().int().min(240).max(4096).optional(),
  height: z.number().int().min(180).max(4096).optional(),
});

export const UnsubscribeTabMessage = z.object({
  type: z.literal('tab.unsubscribe'),
  tabId: TabId,
});

export const TabCreateMessage = z.object({
  type: z.literal('tab.create'),
  url: z.string().max(2048).optional(),
  label: z.string().max(120).optional(),
});

export const TabCloseMessage = z.object({ type: z.literal('tab.close'), tabId: TabId });
export const TabNavigateMessage = z.object({
  type: z.literal('tab.navigate'),
  tabId: TabId,
  url: z.string().min(1).max(2048),
});
export const TabActionMessage = z.object({
  type: z.literal('tab.action'),
  tabId: TabId,
  action: z.enum(['reload', 'back', 'forward', 'stop', 'duplicate']),
});
export const TabRenameMessage = z.object({
  type: z.literal('tab.rename'),
  tabId: TabId,
  label: z.string().max(120),
});
/**
 * Zoom a tab. Implemented as a change of the remote viewport size rather than a
 * CSS transform: shrinking the viewport makes content reflow larger and stay
 * pixel-sharp, whereas CSS page zoom desynchronised input hit-testing from the
 * rendered frame (measured - see docs/decisions.md).
 *
 * The viewport is shared, so zoom is shared by everyone on that tab.
 */
export const TabZoomMessage = z.object({
  type: z.literal('tab.zoom'),
  tabId: TabId,
  zoom: z.number().min(0.25).max(4),
});

export const TabResizeMessage = z.object({
  type: z.literal('tab.resize'),
  tabId: TabId,
  width: z.number().int().min(240).max(4096),
  height: z.number().int().min(180).max(4096),
});

export const ClipboardWriteMessage = z.object({
  type: z.literal('clipboard.write'),
  tabId: TabId,
  text: z.string().max(65536),
});

export const FileChooserRespondMessage = z.object({
  type: z.literal('file.chooser.respond'),
  tabId: TabId,
  /** Names previously returned by POST /api/uploads. Empty array = cancel. */
  files: z.array(z.string().max(255)).max(10),
});

/**
 * Ask the tab's owner for control of it.
 *
 * A tab belongs to whoever opened it; everyone else watches until the owner says
 * otherwise, which is what these two messages negotiate.
 */
export const TabAccessRequestMessage = z.object({
  type: z.literal('tab.access.request'),
  tabId: TabId,
});

export const TabAccessRespondMessage = z.object({
  type: z.literal('tab.access.respond'),
  tabId: TabId,
  /** Who asked. */
  userId: UserId,
  grant: z.boolean(),
});

/** Reopen the most recently closed tab, like Ctrl+Shift+T. */
export const TabReopenMessage = z.object({ type: z.literal('tab.reopen') });

/**
 * Ask what is under the pointer so a context menu can offer the right items.
 * Answered with `context.info`.
 */
export const ContextProbeMessage = z.object({
  type: z.literal('context.probe'),
  tabId: TabId,
  x: z.number().finite(),
  y: z.number().finite(),
});

export const PingMessage = z.object({
  type: z.literal('ping'),
  t: z.number().nonnegative().optional(),
});

export const ClientMessage = z.discriminatedUnion('type', [
  MouseEventMessage,
  KeyboardEventMessage,
  TextInputMessage,
  TouchEventMessage,
  CursorMessage,
  SubscribeTabMessage,
  UnsubscribeTabMessage,
  TabCreateMessage,
  TabCloseMessage,
  TabNavigateMessage,
  TabActionMessage,
  TabRenameMessage,
  TabResizeMessage,
  TabZoomMessage,
  TabReopenMessage,
  TabAccessRequestMessage,
  TabAccessRespondMessage,
  ContextProbeMessage,
  ClipboardWriteMessage,
  FileChooserRespondMessage,
  PingMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export type MouseInput = z.infer<typeof MouseEventMessage>;
export type KeyboardInput = z.infer<typeof KeyboardEventMessage>;
export type TextInput = z.infer<typeof TextInputMessage>;
export type TouchInput = z.infer<typeof TouchEventMessage>;
export type AnyInputMessage = MouseInput | KeyboardInput | TextInput | TouchInput;

// ---------------------------------------------------------------------------
// Server -> Client (types only; the server is the authority, so no parsing)
// ---------------------------------------------------------------------------

export interface TabInfo {
  tabId: string;
  targetId: string;
  label: string | null;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  width: number;
  height: number;
  /** Content magnification; the viewport is base size divided by this. */
  zoom: number;
  createdAt: number;
  /**
   * Whoever opened the tab - by pressing +, or by clicking the link that opened
   * it. Null for tabs nobody claimed (the browser's own first tab, or a tab
   * restored from before this user existed). The owner controls it; everyone else
   * watches unless granted otherwise.
   */
  ownerId: string | null;
  /** Users currently subscribed to this tab. */
  viewers: string[];
}

export interface UserInfo {
  userId: string;
  username: string;
  displayName: string;
  role: Role;
  color: string;
  state: PresenceState;
  currentTabId: string | null;
  lastActivityAt: number;
}

export interface BrowserState {
  browserId: string;
  status: BrowserStatus;
  startedAt: number | null;
  restarts: number;
  tabs: TabInfo[];
  users: UserInfo[];
  limits: { maxTabs: number; maxUsers: number; maxFps: number };
  features: { clipboard: boolean; downloads: boolean; uploads: boolean; webrtc: boolean; devtools: boolean };
}

export interface Cursor {
  userId: string;
  displayName: string;
  color: string;
  x: number;
  y: number;
  active: boolean;
  at: number;
}

export type ServerMessage =
  | { type: 'hello'; protocolVersion: number; self: UserInfo; serverTime: number; state: BrowserState }
  | { type: 'state'; state: BrowserState }
  | { type: 'browser.status'; status: BrowserStatus; message?: string; restarts: number }
  | {
      type: 'tab.created';
      tab: TabInfo;
      /**
       * User whose action opened this tab - the one who pressed +, or who
       * clicked the link that spawned it. Only that client should follow it;
       * everyone else stays where they are.
       */
      openedBy?: string | null;
    }
  | { type: 'tab.closed'; tabId: string }
  | { type: 'tab.updated'; tab: TabInfo }
  | { type: 'tab.navigation'; tabId: string; url: string; title: string; loading: boolean }
  | { type: 'tab.permissions'; tabId: string; permission: TabPermission | null }
  | { type: 'presence'; users: UserInfo[] }
  | { type: 'cursors'; tabId: string; cursors: Cursor[] }
  | { type: 'stream.started'; tabId: string; width: number; height: number }
  | { type: 'stream.stopped'; tabId: string; reason: string }
  | { type: 'input.ack'; eventId: string; tabId: string; serverReceiveTime: number; dispatchedAt: number; queueDepth: number }
  | { type: 'clipboard.data'; tabId: string; text: string }
  /** Someone is asking the owner of this tab for control of it. */
  | { type: 'tab.access.requested'; tabId: string; userId: string; displayName: string; at: number }
  /** The owner answered a request this client made. */
  | { type: 'tab.access.decided'; tabId: string; granted: boolean; byDisplayName: string }
  | {
      type: 'context.info';
      tabId: string;
      /** Link under the pointer, if any - enables "open in new tab". */
      link: string | null;
      /** Image under the pointer, if any. */
      image: string | null;
      /** Current selection, so Copy can be offered only when it would do something. */
      selection: string;
    }
  | { type: 'file.chooser'; tabId: string; multiple: boolean; accept: string[] }
  | { type: 'download'; tabId: string | null; state: 'started' | 'progress' | 'completed' | 'canceled'; guid: string; fileName: string; received?: number; total?: number }
  | { type: 'metrics'; metrics: ServerMetrics }
  | { type: 'server.shutdown'; reason: string }
  | { type: 'pong'; t?: number; serverTime: number }
  | { type: 'error'; code: ErrorCode; message: string; tabId?: string };

export interface ServerMetrics {
  cpuPercent: number;
  rssBytes: number;
  tabs: number;
  users: number;
  framesPerSecond: number;
  bytesPerSecond: number;
  inputQueueDepth: number;
  p50InputDispatchMs: number;
  p95InputDispatchMs: number;
  droppedFrames: number;
  uptimeSeconds: number;
}

/** Stable codes so the client can show human text and never a raw stack trace. */
export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'invalid_message',
  'rate_limited',
  'tab_not_found',
  'tab_limit',
  'user_limit',
  'browser_unavailable',
  'page_crashed',
  'navigation_blocked',
  'feature_disabled',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  unauthorized: 'Your session expired. Please sign in again.',
  forbidden: 'You do not have permission to do that.',
  invalid_message: 'The client sent something this server could not understand.',
  rate_limited: 'Slow down - too many messages.',
  tab_not_found: 'That tab is no longer open.',
  tab_limit: 'The maximum number of tabs is already open.',
  user_limit: 'The browser is at its user limit. Try again shortly.',
  browser_unavailable: 'The browser is restarting. Reconnecting...',
  page_crashed: 'That page ran out of memory and was reloaded.',
  navigation_blocked: 'That address is not allowed.',
  feature_disabled: 'That feature is disabled on this server.',
  internal: 'Something went wrong on the server.',
};

// ---------------------------------------------------------------------------
// Binary frame envelope
// ---------------------------------------------------------------------------

/**
 * Binary frame layout (little-endian):
 *   0    u8   magic (FRAME_MAGIC)
 *   1    u8   flags (reserved, 0)
 *   2    u16  header byte length
 *   4    ...  UTF-8 JSON FrameHeader
 *   ...  ...  image bytes (JPEG)
 */
export const FRAME_MAGIC = 0xcb;
export const FRAME_PREFIX_BYTES = 4;

export interface FrameHeader {
  tabId: string;
  /** Server-side monotonic frame counter for this tab. */
  seq: number;
  width: number;
  height: number;
  /** Page scroll offsets, so overlays can stay pinned to content. */
  scrollX: number;
  scrollY: number;
  /** CDP capture timestamp (ms since epoch) when available. */
  capturedAt: number;
  /** Server clock when the frame was written to the socket. */
  sentAt: number;
  format: 'jpeg';
  /**
   * Device pixels per CSS pixel in this frame. width/height are device pixels,
   * so the page's coordinate space is width/scale x height/scale - which is what
   * input events must be expressed in.
   */
  scale?: number;
}

export function encodeFrame(header: FrameHeader, image: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(FRAME_PREFIX_BYTES + json.length + image.length);
  const view = new DataView(out.buffer);
  out[0] = FRAME_MAGIC;
  out[1] = 0;
  view.setUint16(2, json.length, true);
  out.set(json, FRAME_PREFIX_BYTES);
  out.set(image, FRAME_PREFIX_BYTES + json.length);
  return out;
}

export function decodeFrame(buf: ArrayBuffer): { header: FrameHeader; image: Uint8Array } | null {
  if (buf.byteLength < FRAME_PREFIX_BYTES) return null;
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== FRAME_MAGIC) return null;
  const headerLen = new DataView(buf).getUint16(2, true);
  if (buf.byteLength < FRAME_PREFIX_BYTES + headerLen) return null;
  const json = new TextDecoder().decode(bytes.subarray(FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + headerLen));
  return {
    header: JSON.parse(json) as FrameHeader,
    image: bytes.subarray(FRAME_PREFIX_BYTES + headerLen),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Chromium input modifier bits. */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

export function modifiersFrom(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (e.altKey ? MOD.alt : 0) | (e.ctrlKey ? MOD.ctrl : 0) | (e.metaKey ? MOD.meta : 0) | (e.shiftKey ? MOD.shift : 0)
  );
}

/**
 * Which of Orbit's own shortcuts a key event is, if any.
 *
 * Alt/Option, and matched on `code` - the physical key - because on a Mac
 * Option+T produces the key "†", Option+W "∑" and Option+1 "¡". Matching on
 * `key` meant none of these worked on macOS at all.
 *
 * Lives here, rather than in the component, so it can be tested against the
 * events a real keyboard produces on each platform.
 */
export function shortcutForKey(e: {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): string | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
  if (digit) return `selectTab:${digit}`;
  switch (e.code) {
    case 'KeyF':
      // Full screen. Alt, not F11: F11 is the host browser's and never reaches us.
      return 'toggleFullscreen';
    case 'KeyK':
      // Keyboard capture. Alt+K works while captured too, which is what makes it
      // a usable way out: the host browser's own chords are unavailable then.
      return 'toggleCapture';
    case 'KeyT':
      return e.shiftKey ? 'reopenTab' : 'newTab';
    case 'KeyW':
      return 'closeTab';
    case 'KeyD':
      return 'focusAddress';
    case 'ArrowLeft':
      return 'back';
    case 'ArrowRight':
      return 'forward';
    default:
      return null;
  }
}

/**
 * The same modifiers, as the *remote* browser needs to see them.
 *
 * A viewer on a Mac holds Command for every accelerator - copy, paste, select
 * all - and that arrives as Meta. The browser being driven is the Linux one in
 * the container, where Meta is the Super key and means nothing, so Command has
 * to travel as Ctrl. Measured: without this, ⌘C and ⌘V did nothing at all.
 *
 * Ctrl is left alone, so a Mac user who presses Ctrl+C (or anyone on Linux or
 * Windows) is unaffected, and Ctrl+Command collapses to a single Ctrl.
 */
export function remoteModifiers(
  e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  commandIsAccelerator: boolean,
): number {
  const raw = modifiersFrom(e);
  if (!commandIsAccelerator || !e.metaKey) return raw;
  return (raw & ~MOD.meta) | MOD.ctrl;
}

/**
 * Palette for per-user dots and cursors.
 *
 * A curated list rather than `hue = hash % 360`: adjacent hues are
 * indistinguishable at the size of an 8px dot, and user ids share a timestamp
 * prefix, so a plain hash regularly produced two people in near-identical
 * colours. These twelve are far apart in hue and all readable on a dark UI.
 */
export const USER_COLORS = [
  '#60a5fa', // blue
  '#f87171', // red
  '#34d399', // emerald
  '#fbbf24', // amber
  '#a78bfa', // violet
  '#22d3ee', // cyan
  '#f472b6', // pink
  '#a3e635', // lime
  '#fb923c', // orange
  '#e879f9', // fuchsia
  '#fde047', // yellow
  '#94a3b8', // slate
] as const;

/**
 * Colour for the Nth user. Assigning by position guarantees that any group of
 * up to USER_COLORS.length people all get different colours - hashing the user
 * id cannot promise that, and in practice collided often enough that two people
 * regularly shared a dot.
 *
 * Past the curated palette it falls back to golden-angle hue rotation, which
 * keeps successive colours as far apart as possible for any count.
 */
export function colorForIndex(index: number): string {
  const i = Math.max(0, Math.floor(index));
  if (i < USER_COLORS.length) return USER_COLORS[i]!;
  const n = i - USER_COLORS.length;
  const hue = Math.round((n * 137.508) % 360);
  // Alternate lightness so a wrapped hue still reads as a different colour.
  return `hsl(${hue} 72% ${n % 2 === 0 ? 62 : 45}%)`;
}

/**
 * Deterministic colour from a user id alone, for callers with no index to hand.
 * Prefer colorForIndex: this can give two users the same colour.
 */
export function userColor(userId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return USER_COLORS[hash % USER_COLORS.length]!;
}

/** Zoom steps, matching what a browser's own zoom control offers. */
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

/** Next step up or down from the current value. */
export function nextZoom(current: number, direction: 1 | -1): number {
  const i = ZOOM_STEPS.reduce((best, z, idx) => (Math.abs(z - current) < Math.abs(ZOOM_STEPS[best]! - current) ? idx : best), 0);
  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + direction))]!;
}

export const ROLE_RANK: Record<Role, number> = { viewer: 0, user: 1, admin: 2 };
export const PERMISSION_RANK: Record<TabPermission, number> = { view: 0, control: 1, admin: 2 };

/** True when `have` is at least as strong as `need`. */
export function permits(have: TabPermission | null, need: TabPermission): boolean {
  return have !== null && PERMISSION_RANK[have] >= PERMISSION_RANK[need];
}
