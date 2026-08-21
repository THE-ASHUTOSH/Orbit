import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'orbit-theme';
const ORDER: ThemeChoice[] = ['system', 'light', 'dark'];

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    // Private windows and blocked site data throw on access.
    return 'system';
  }
}

/**
 * Applies the choice by stamping data-theme on <html>; 'system' removes it so
 * the prefers-color-scheme rules take over.
 *
 * Note there is no pre-paint inline script to do this earlier, because the app's
 * CSP forbids inline scripts. Anyone on 'system' therefore sees no flash at all,
 * and an explicit choice may flash for one frame on a cold load.
 */
function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function useTheme(): { theme: ThemeChoice; cycle: () => void } {
  const [theme, setTheme] = useState<ThemeChoice>(read);

  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* nothing to do - the choice just will not persist */
    }
  }, [theme]);

  const cycle = useCallback(() => {
    setTheme((t) => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length]!);
  }, []);

  return { theme, cycle };
}
