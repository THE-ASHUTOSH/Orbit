/**
 * Chromium profile housekeeping.
 *
 * Chromium marks a profile as in-use with SingletonLock/Socket/Cookie, which are
 * symlinks naming "<hostname>-<pid>" and a socket under /tmp. If the process is
 * killed rather than shut down (container stop, OOM, SIGKILL) they survive, and
 * Chromium then refuses to start with exit code 21 - "the profile appears to be
 * in use ... on another computer". A container's hostname changes on every
 * recreate, so a persisted profile would be permanently unusable.
 */
import { rmSync, lstatSync } from 'node:fs';
import path from 'node:path';

export const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const;

/**
 * Remove the in-use markers from a profile directory. Returns the names removed.
 *
 * Only ever call this when no Chromium owns the profile: exactly one process
 * does, and it is the child this server is about to spawn.
 */
export function clearStaleProfileLocks(profileDir: string): string[] {
  const removed: string[] = [];
  for (const name of SINGLETON_FILES) {
    const file = path.join(profileDir, name);
    // lstat, not existsSync: these are dangling symlinks, and existsSync follows
    // the link and reports false - skipping the very files that block startup.
    try {
      lstatSync(file);
    } catch {
      continue;
    }
    rmSync(file, { force: true });
    removed.push(name);
  }
  return removed;
}
