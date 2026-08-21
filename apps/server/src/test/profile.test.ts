import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearStaleProfileLocks } from '../browser/profile.js';

const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

test('profile: dangling singleton symlinks are removed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-profile-'));
  // Exactly what a SIGKILLed container leaves behind: symlinks to a hostname/pid
  // and a socket path that no longer exist.
  symlinkSync('9e55fc8a06a2-16', path.join(dir, 'SingletonLock'));
  symlinkSync('/tmp/org.chromium.Chromium.gone/SingletonSocket', path.join(dir, 'SingletonSocket'));
  symlinkSync('2410086512363508322', path.join(dir, 'SingletonCookie'));

  // Guard against the bug this test exists for: existsSync follows the link and
  // says "not there", which is why lstat has to be used.
  assert.equal(existsSync(path.join(dir, 'SingletonLock')), false, 'dangling link looks absent to existsSync');

  const removed = clearStaleProfileLocks(dir);
  assert.deepEqual(removed.sort(), ['SingletonCookie', 'SingletonLock', 'SingletonSocket']);
  for (const name of removed) assert.equal(exists(path.join(dir, name)), false);
  rmSync(dir, { recursive: true, force: true });
});

test('profile: real user data is never touched', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-profile-'));
  writeFileSync(path.join(dir, 'Cookies'), 'precious');
  writeFileSync(path.join(dir, 'Local State'), '{}');
  assert.deepEqual(clearStaleProfileLocks(dir), []);
  assert.ok(exists(path.join(dir, 'Cookies')));
  assert.ok(exists(path.join(dir, 'Local State')));
  rmSync(dir, { recursive: true, force: true });
});

test('profile: a missing profile directory is not an error', () => {
  assert.deepEqual(clearStaleProfileLocks(path.join(tmpdir(), 'orbit-does-not-exist-' + Date.now())), []);
});
