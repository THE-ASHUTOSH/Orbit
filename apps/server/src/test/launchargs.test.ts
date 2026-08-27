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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

/**
 * DEVICE_SCALE_FACTOR has to reach the command line to mean anything.
 *
 * It used to be passed only to Emulation.setDeviceMetricsOverride, which tells
 * the page its DPR while the screencast keeps capturing at the window's scale: a
 * knob that reported success and changed nothing. Frames stayed 1920x912 at an
 * identical 56 KB/frame, and got *softer*. See docs/performance.md#sharpness.
 */
test('launch args: the device scale factor reaches Chromium, fractions included', async () => {
  const { config } = await import('../config.js');
  const set = (n: number) => ((config as { deviceScaleFactor: number }).deviceScaleFactor = n);
  const original = config.deviceScaleFactor;
  try {
    for (const n of [1.25, 1.5, 2, 3]) {
      set(n);
      assert.ok(
        args().includes(`--force-device-scale-factor=${n}`),
        `${n}x must reach the command line, or the extra density never reaches the frames`,
      );
    }
    set(1);
    assert.ok(!args().some((a) => a.startsWith('--force-device-scale-factor')), 'at 1x the flag is noise');
  } finally {
    set(original);
  }
});

test('scale factor: fractions pass through, nonsense and out-of-range do not', async () => {
  const { scaleFactor } = await import('../config.js');
  assert.equal(scaleFactor('1.5'), 1.5, 'fractional densities are the useful ones');
  assert.equal(scaleFactor('1.25'), 1.25);
  assert.equal(scaleFactor('2'), 2);
  assert.equal(scaleFactor(undefined), 1, 'unset is 1x');
  assert.equal(scaleFactor(''), 1);
  assert.equal(scaleFactor('abc'), 1, 'a typo must not stop the browser starting');
  assert.equal(scaleFactor('0.5'), 1, 'below 1 would send fewer pixels than the page has');
  assert.equal(scaleFactor('-2'), 1);
  assert.equal(scaleFactor('9'), 3, 'clamped, or the X screen outgrows the container');
});

/**
 * The X screen is sized by shell, in a different language from the clamp above,
 * and the two disagreeing is the black-frame bug: a window bigger than its
 * screen captures as black. So run the real function out of the real file.
 */
test('virtual screen: sized from MAX_VIEWPORT x the same clamped scale', () => {
  const script = readFileSync(new URL('../../../../docker-entrypoint.sh', import.meta.url), 'utf8');
  const fn = /^\s*scaled\(\) \{.*$/m.exec(script)?.[0];
  assert.ok(fn, 'scaled() must still exist in docker-entrypoint.sh');
  const geometry = (dsf: string) =>
    execFileSync('sh', ['-c', `DSF='${dsf}'\n${fn}\necho "$(scaled 2560)x$(scaled 1440)"`], {
      encoding: 'utf8',
    }).trim();
  assert.equal(geometry('1'), '2560x1440');
  assert.equal(geometry('1.5'), '3840x2160', 'fractional scales must not fall back to 1x');
  assert.equal(geometry('1.25'), '3200x1800');
  assert.equal(geometry('2'), '5120x2880');
  assert.equal(geometry('9'), '7680x4320', 'clamped to 3x, exactly as config.ts clamps');
  assert.equal(geometry('abc'), '2560x1440', 'a typo is 1x, never a 3x guess or a zero-sized screen');
  assert.equal(geometry('0.5'), '2560x1440');
  assert.equal(geometry(''), '2560x1440');
});
