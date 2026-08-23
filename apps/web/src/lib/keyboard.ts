/**
 * Keyboard capture: hand the chords this browser keeps for itself to the remote
 * browser instead.
 *
 * A page cannot cancel ⌘T, ⌘W, ⌘L, ⌘1-9 or Escape - the browser acts on them
 * before the page is asked. The one documented exception is the Keyboard Lock
 * API, which exists precisely for remote-desktop and streaming pages: while the
 * page is fullscreen and holding a lock, the browser delivers those keys to the
 * page instead of acting on them itself.
 *
 * Two conditions, both measured rather than assumed:
 *
 * - **Fullscreen.** The lock only takes effect in fullscreen, and requesting
 *   fullscreen needs a user gesture - so capture must be started from a click or
 *   a keypress, never from an effect.
 * - **A secure context.** `navigator.keyboard` is not exposed on plain http, so
 *   over a LAN IP it is simply absent (http://127.0.0.1 counts as secure, which
 *   is why it works on the machine running Orbit). Without it, capture still
 *   claims everything a page *is* allowed to cancel - ⌘R, ⌘S, ⌘P, ⌘F, ⌘D and
 *   friends - and `mode` reports 'partial' so the UI can say so.
 */

interface KeyboardLock {
  lock?: (codes?: string[]) => Promise<void>;
  unlock?: () => void;
}

const keyboard = (): KeyboardLock | undefined =>
  (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

/** Whether this browser can capture the chords it normally reserves. */
export const fullCaptureAvailable = (): boolean => typeof keyboard()?.lock === 'function';

export type CaptureMode = 'locked' | 'partial';

/** Start capturing. Must be called from a user gesture. */
export async function captureKeyboard(element: HTMLElement): Promise<CaptureMode> {
  if (!document.fullscreenElement) {
    // A rejection here is not fatal: partial capture still works unfullscreened.
    await element.requestFullscreen?.().catch(() => {});
  }
  const lock = keyboard()?.lock;
  if (!lock || !document.fullscreenElement) return 'partial';
  try {
    await lock.call(keyboard(), undefined);
    return 'locked';
  } catch {
    return 'partial';
  }
}

/** Stop capturing, and give the screen back if we took it. */
export async function releaseKeyboard(): Promise<void> {
  keyboard()?.unlock?.();
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
}
