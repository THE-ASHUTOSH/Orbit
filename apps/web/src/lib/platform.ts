/**
 * What this viewer's keyboard is actually called.
 *
 * The same physical key is Alt on Windows and Linux and Option on a Mac, and the
 * same accelerator is Ctrl in one place and Command in the other. Orbit matches
 * shortcuts by physical key (see shortcutForKey), so only the *labels* differ -
 * but a label that names the wrong key is worse than no label.
 */
export const IS_APPLE = /mac|iphone|ipad|ipod/i.test(
  (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '',
);

/** "Option" on a Mac, "Alt" everywhere else. */
export const ALT_KEY = IS_APPLE ? 'Option' : 'Alt';

/** The accelerator key, for text that mentions copy/paste and friends. */
export const ACCEL_KEY = IS_APPLE ? 'Command' : 'Ctrl';

/** e.g. altChord('K') -> "Option+K" or "Alt+K". */
export const altChord = (key: string): string => `${ALT_KEY}+${key}`;
