import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeUrl, resolveTabUrl, viewportFor, TabManager } from '../browser/TabManager.js';
import { config } from '../config.js';
import { openInMemoryForTests } from '../db.js';
import { errorCode } from '../ws/hub.js';

test('urls: bare hostnames become https', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('  example.com/path?q=1 '), 'https://example.com/path?q=1');
  assert.equal(normalizeUrl('http://192.168.1.10:8080/x'), 'http://192.168.1.10:8080/x');
});

test('urls: plain text becomes a search, not a broken navigation', () => {
  const searched = normalizeUrl('how tall is everest');
  assert.match(searched!, /^https:\/\/duckduckgo\.com\/\?q=how\+tall\+is\+everest|%20/);
});

test('urls: dangerous schemes are refused', () => {
  for (const bad of [
    'file:///etc/passwd',
    'FILE:///etc/passwd',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'view-source:https://example.com',
    'filesystem:https://example.com/temporary/x',
    'chrome-extension://abc/page.html',
  ]) {
    assert.equal(normalizeUrl(bad), null, `${bad} must be blocked`);
  }
});

test('urls: about:blank is the one non-http exception', () => {
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
});

test('urls: empty input is rejected', () => {
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl('   '), null);
});

test('urls: a new tab falls back to the configured home page', () => {
  assert.equal(resolveTabUrl(undefined, 'https://www.google.com'), 'https://www.google.com/');
  assert.equal(resolveTabUrl(null, 'example.com'), 'https://example.com/', 'a bare home host is normalised');
  assert.equal(resolveTabUrl('https://other.test/x', 'https://www.google.com'), 'https://other.test/x', 'explicit wins');
  assert.equal(resolveTabUrl(undefined, 'about:blank'), 'about:blank', 'the offline default');
  assert.equal(resolveTabUrl(undefined, ''), 'about:blank', 'empty home is not a navigation');
  // A home page that is not a usable http(s) URL must not break tab creation.
  assert.equal(resolveTabUrl(undefined, 'file:///etc/passwd'), 'about:blank');
});

/**
 * A Chromium that behaves like the real one in the way that matters here: a new
 * target's session arrives *after* createTarget has returned, which is the gap
 * the tab limit has to survive.
 */
class FakeBrowserCdp extends EventEmitter {
  connected = true;
  private created = 0;

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === 'Target.getTargets') return { targetInfos: [] };
    if (method === 'Target.createTarget') {
      const targetId = `target-${++this.created}`;
      setTimeout(
        () =>
          this.emit('Target.attachedToTarget', {
            params: {
              sessionId: `session-${targetId}`,
              targetInfo: { targetId, type: 'page', url: String(params?.url ?? 'about:blank'), title: '' },
            },
          }),
        5,
      );
      return { targetId };
    }
    return {};
  }
  post(): void {}
}

test('tabs: a burst of creates cannot exceed MAX_TABS', async () => {
  /**
   * A tab only appears in the manager once Chromium attaches its session, so a
   * limit checked against that map alone is no limit under concurrency: every
   * request in a burst passes before any of them has registered. Measured with
   * the stress harness before this was fixed - 24 tabs against a cap of 20.
   */
  openInMemoryForTests();
  const cdp = new FakeBrowserCdp();
  const tabs = new TabManager({ browserId: 'brw_test' } as never);
  await tabs.attach(cdp as never);

  const room = config.maxTabs - tabs.count;
  const attempts = room + 6;
  const results = await Promise.allSettled(
    Array.from({ length: attempts }, () => tabs.createTab({ createdBy: null })),
  );
  const created = results.filter((r) => r.status === 'fulfilled').length;
  const refused = results.filter(
    (r) => r.status === 'rejected' && (r.reason as Error).message === 'tab_limit',
  ).length;

  assert.ok(tabs.count <= config.maxTabs, `${tabs.count} tabs open against a limit of ${config.maxTabs}`);
  assert.equal(created, room, `all the room available was used (${created}/${room})`);
  assert.equal(refused, 6, 'and the overflow was refused with tab_limit, not silently dropped');
});

test('errors: losing a race with a closing tab is reported as tab_not_found', () => {
  // Chromium's phrasing when the page went away mid-request. Reporting these as
  // "internal" told the user something was broken and filled the log with
  // errors, when the truthful answer is that the tab is gone.
  assert.equal(errorCode(new Error('Session with given id not found.')), 'tab_not_found');
  assert.equal(errorCode(new Error('No target with given id found')), 'tab_not_found');
  assert.equal(errorCode(new Error('Target closed')), 'tab_not_found');
  // Codes the server raises itself still pass through unchanged...
  assert.equal(errorCode(new Error('tab_limit')), 'tab_limit');
  assert.equal(errorCode(new Error('forbidden')), 'forbidden');
  // ...and a genuine surprise is still internal, so real bugs stay visible.
  assert.equal(errorCode(new Error('TypeError: x is not a function')), 'internal');
});

// --- viewport geometry ------------------------------------------------------

const HD = { width: 1920, height: 1080 };
const SCREEN = { width: 2560, height: 1440 };

test('viewport: pinned keeps the resolution and takes only the shape from the client', () => {
  /**
   * The reported bug: subscribe honoured PIN_VIEWPORT and resize did not, so a
   * tab's resolution flipped between the pinned size and the client's raw window
   * depending on which message landed last - and changed again on every refresh.
   * One rule, one answer.
   */
  const wide = viewportFor({ width: 1280, height: 608 }, { configured: HD, max: SCREEN, pin: true });
  assert.equal(wide.width, 1920, 'the configured width is kept whatever the client asks for');
  // 1920 * (608/1280) = 912, already on the grid.
  assert.equal(wide.height, 912, 'only the aspect follows the viewer');

  const tall = viewportFor({ width: 800, height: 1200 }, { configured: HD, max: SCREEN, pin: true });
  assert.equal(tall.width, 1920);
  assert.ok(tall.height <= SCREEN.height, 'and it never exceeds what the screen can show');
});

test('viewport: unpinned follows the client, and falls back to the configured size', () => {
  assert.deepEqual(viewportFor({ width: 1280, height: 720 }, { configured: HD, max: SCREEN, pin: false }), {
    width: 1280,
    height: 720,
  });
  assert.deepEqual(viewportFor(null, { configured: HD, max: SCREEN, pin: false }), HD);
});

test('viewport: a few pixels of client difference produce the same viewport', () => {
  /**
   * Snapped to a 16px grid. Without this, a window a couple of pixels taller
   * gave a different viewport, a different stream restart and a page that looked
   * subtly different for no reason anyone could see.
   */
  const heightFor = (h: number) =>
    viewportFor({ width: 1280, height: h }, { configured: HD, max: SCREEN, pin: true }).height;

  // Jitter inside one step is invisible.
  const cluster = [608, 610, 613].map(heightFor);
  assert.equal(new Set(cluster).size, 1, `identical within a step: ${cluster.join(',')}`);

  /**
   * Across a wider range it moves in whole steps and only ever upwards - a 20px
   * taller window is genuinely 30px more viewport at this scale, so the point is
   * not that the number never changes but that it changes predictably: always a
   * multiple of the step, never oscillating.
   */
  const spread = [560, 580, 600, 620, 640].map(heightFor);
  assert.ok(spread.every((h) => h % 16 === 0), `every size is on the grid: ${spread.join(',')}`);
  assert.deepEqual(spread, [...spread].sort((a, b) => a - b), `monotone in the window height: ${spread.join(',')}`);
});

test('viewport: never larger than the screen the window lives on', () => {
  // Zooming out asks for more than the screen can show. Granting it produced a
  // window smaller than its viewport, and a screencast of that is black.
  const huge = viewportFor({ width: 4000, height: 3000 }, { configured: HD, max: SCREEN, pin: false });
  assert.equal(huge.width, SCREEN.width);
  assert.equal(huge.height, SCREEN.height);
  // And never absurdly small either.
  const tiny = viewportFor({ width: 10, height: 10 }, { configured: HD, max: SCREEN, pin: false });
  assert.ok(tiny.width >= 240 && tiny.height >= 180, `${tiny.width}x${tiny.height}`);
});
