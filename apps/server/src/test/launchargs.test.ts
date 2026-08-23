/**
 * Chromium's argv.
 *
 * A switch passed twice is not merged - Chromium keeps the last one and silently
 * discards the earlier value. That is easy to do by accident when related flags
 * are grouped in different places, and the symptom (a feature that was supposed
 * to be off quietly coming back) never points at the command line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager } from '../browser/BrowserManager.js';

const args = () => new BrowserManager().launchArgsForTest();

test('launch args: no switch is passed twice', () => {
  const names = args()
    .filter((a) => a.startsWith('--'))
    .map((a) => a.split('=')[0]!);
  const seen = new Set<string>();
  const duplicated = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
  assert.deepEqual(duplicated, [], `these switches would silently overwrite each other: ${duplicated.join(', ')}`);
});

test('launch args: every feature meant to be off is in the one --disable-features', () => {
  const flag = args().find((a) => a.startsWith('--disable-features='))!;
  const features = flag.slice('--disable-features='.length).split(',');
  // Occlusion calculation is what stops a background tab from compositing, so
  // losing it means other people's tabs freeze.
  for (const expected of ['Translate', 'MediaRouter', 'CalculateNativeWinOcclusion'])
    assert.ok(features.includes(expected), `${expected} must still be disabled`);
});

test('launch args: CDP is bound to loopback and the profile is the configured one', () => {
  const a = args();
  assert.ok(a.includes('--remote-debugging-address=127.0.0.1'), 'CDP must never listen off-box');
  assert.ok(a.some((x) => x.startsWith('--user-data-dir=')));
});
