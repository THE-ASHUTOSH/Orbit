/**
 * Drives the real UI in a real browser: log in, create and switch tabs,
 * navigate, click, type, scroll, watch pixels change, and close a tab.
 *
 * Two independent browser contexts stand in for two machines on the LAN, which
 * is what makes the multi-user assertions meaningful: separate cookie jars,
 * separate WebSockets, one shared Chromium behind them.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

const PASSWORD = process.env.ADMIN_PASSWORD ?? 'changeme';
const USERNAME = process.env.ADMIN_USERNAME ?? 'admin';

/**
 * Address-bar URLs are resolved by the REMOTE browser, not by the test browser,
 * so they must be absolute and reachable from inside the container. The server's
 * own animated self-test page is served at /selftest on its own port, which is
 * why 127.0.0.1:3030 is correct here even when the test drives it from the host.
 * (Typing a bare path would be treated as a search - correctly.)
 */
const REMOTE_SELFTEST = process.env.SELFTEST_URL ?? 'http://127.0.0.1:3030/selftest';

/**
 * Where a signed-in session is saved, so the cleanup hook can reuse it.
 *
 * The server rate-limits logins per IP (10 a minute), and a suite that signs in
 * once per test is close enough to that ceiling that one more login for cleanup
 * would trip it. Note that two full runs inside the same minute still can.
 */
const SESSION_STATE = 'test-results/.session.json';

async function signIn(page: Page, username = USERNAME, password = PASSWORD) {
  /**
   * Reuse the session from an earlier test when there is one.
   *
   * Nine logins in a forty-second run sits right on the server's limit of ten a
   * minute per IP - which is the limiter working correctly, and a pointless way
   * for this suite to fail. Cookies from the first sign-in are enough.
   */
  if (username === USERNAME && existsSync(SESSION_STATE)) {
    const saved = JSON.parse(readFileSync(SESSION_STATE, 'utf8')) as { cookies?: never[] };
    if (saved.cookies?.length) {
      await page.context().addCookies(saved.cookies);
      await page.goto('/');
      if (await page.getByRole('button', { name: 'Menu' }).isVisible().catch(() => false)) return;
    }
  }
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Login' }).click();
  // The ⋮ menu only exists once signed in; sign-out lives inside it now.
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
  if (username === USERNAME) await page.context().storageState({ path: SESSION_STATE });
}

/**
 * Checksum of the whole canvas, sampled on a grid.
 *
 * Deliberately not a crop: a centre band is blank white whenever the remote
 * viewport is larger than this client's stage (the page's content then sits in
 * the top-left of the frame), and a corner or the head of toDataURL() is mostly
 * background. Sampling across everything makes "is there a page here" and "did
 * the page change" both mean what they say.
 */
async function canvasSignature(page: Page): Promise<{ sum: number; distinct: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas || canvas.width === 0) return { sum: 0, distinct: 0 };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { sum: 0, distinct: 0 };
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const step = 4 * 17; // every 17th pixel: cheap, and no alignment with any grid the page draws
    let sum = 0;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += step) {
      const px = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
      sum = (sum + px * (i + 1)) % 2147483647;
      if (seen.size < 64) seen.add(px);
    }
    return { sum, distinct: seen.size };
  });
}

/** A real frame has been painted when the centre is not one flat colour. */
async function canvasHasContent(page: Page): Promise<boolean> {
  return (await canvasSignature(page)).distinct > 1;
}

async function addressBar(page: Page) {
  return page.getByPlaceholder('Search or enter address');
}

/**
 * The element that actually receives input: a transparent textarea sits over the
 * canvas (it is what makes IME and key events work), so clicking the canvas
 * itself is always intercepted.
 */
const stage = (page: Page) => page.getByRole('textbox', { name: /Remote browser viewport/ });

/**
 * Leave the shared browser as it was found: one tab, parked on a page that does
 * not repaint.
 *
 * Without this, every run leaks a tab still animating the self-test page - and
 * since all runs share one Chromium, a few runs are enough to saturate it and
 * make the pixel assertions fail for reasons that have nothing to do with the
 * code under test.
 */
test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: SESSION_STATE });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
    const tabIds = async () =>
      page.evaluate(async () => {
        const { state } = await (await fetch('/api/state')).json();
        return (state.tabs as { tabId: string }[]).map((t) => t.tabId);
      });
    const ids = await tabIds();
    for (const id of ids.slice(0, -1)) {
      const row = page.locator(`div[title*="${id}"]`);
      await row.hover();
      await row.getByRole('button', { name: 'Close tab' }).click();
      await expect.poll(async () => (await tabIds()).includes(id), { timeout: 20_000 }).toBe(false);
    }
    const bar = await addressBar(page);
    await bar.fill('about:blank');
    await bar.press('Enter');
  } finally {
    await context.close();
  }
});

test.describe('orbit UI', () => {
  test('signs in, streams a page, and accepts real input', async ({ page }) => {
    await signIn(page);

    // A tab exists on arrival (the server always keeps one open).
    await expect(page.locator('canvas')).toBeVisible();

    // Navigate to the server's own animated self-test page: no Internet needed,
    // and it repaints continuously so frames must keep arriving.
    await (await addressBar(page)).fill(REMOTE_SELFTEST);
    await (await addressBar(page)).press('Enter');

    await expect.poll(() => canvasHasContent(page), { timeout: 30_000 }).toBe(true);

    // Frames keep coming: the self-test page repaints a clock every 33ms, so the
    // painted pixels must change between samples.
    const before = await canvasSignature(page);
    await expect
      .poll(async () => (await canvasSignature(page)).sum !== before.sum, { timeout: 15_000 })
      .toBe(true);
  });

  test('creates, renames, switches and closes tabs', async ({ page }) => {
    await signIn(page);
    const tabs = page.locator('div[title*="tab_"]');
    const initial = await tabs.count();

    await page.getByRole('button', { name: 'New tab' }).click();
    await expect(tabs).toHaveCount(initial + 1);

    // The new tab is selectable and its own stream starts.
    await tabs.nth(initial).click();
    await expect(page.locator('canvas')).toBeVisible();

    await tabs.nth(initial).hover();
    await tabs.nth(initial).getByRole('button', { name: 'Close tab' }).click();
    await expect(tabs).toHaveCount(initial);
  });

  test('two clients see each other and work on different tabs at once', async ({ browser }) => {
    const contexts: BrowserContext[] = [await browser.newContext(), await browser.newContext()];
    const [a, b] = [await contexts[0]!.newPage(), await contexts[1]!.newPage()];
    try {
      await signIn(a);
      await signIn(b);

      // Presence: each client appears in the other's status bar.
      await expect(a.locator('text=/\\(you\\)/')).toBeVisible();
      await expect(b.locator('text=/\\(you\\)/')).toBeVisible();

      // A takes a fresh tab, B stays on the first one.
      await a.getByRole('button', { name: 'New tab' }).click();
      const aTabs = a.locator('div[title*="tab_"]');
      await aTabs.last().click();

      await (await addressBar(a)).fill(REMOTE_SELFTEST);
      await (await addressBar(a)).press('Enter');
      await (await addressBar(b)).fill(REMOTE_SELFTEST);
      await (await addressBar(b)).press('Enter');

      // Both stream simultaneously.
      await expect.poll(() => canvasHasContent(a), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => canvasHasContent(b), { timeout: 30_000 }).toBe(true);
    } finally {
      for (const c of contexts) await c.close();
    }
  });

  test('bookmarks a page, lists it, and removes it', async ({ page }) => {
    await signIn(page);
    await (await addressBar(page)).fill(REMOTE_SELFTEST);
    await (await addressBar(page)).press('Enter');

    /**
     * Start from "not bookmarked", whatever an earlier run left behind - and do
     * it through the API rather than by clicking the star, so the delete is known
     * to have completed before the add is sent. Only this page's bookmark is
     * touched; anything else in the shared list is left alone.
     */
    await page.evaluate(async (url) => {
      const { bookmarks } = await (await fetch('/api/bookmarks')).json();
      for (const b of bookmarks as { id: string; url: string }[])
        if (b.url === url) await fetch(`/api/bookmarks/${b.id}`, { method: 'DELETE' });
    }, REMOTE_SELFTEST);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();

    const star = page.getByRole('button', { name: 'Bookmark this page' });
    await expect(star).toBeVisible({ timeout: 20_000 });
    await star.click();

    // The star flips, which means the server confirmed the bookmark.
    const unstar = page.getByRole('button', { name: 'Remove bookmark' });
    await expect(unstar).toBeVisible();

    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: 'Bookmarks' }).click();
    const panel = page.locator('aside', { hasText: 'Bookmarks' });
    // .first(): the row shows the title over the URL, and a page bookmarked
    // before it reported a title shows the URL in both.
    await expect(panel.getByText(REMOTE_SELFTEST, { exact: false }).first()).toBeVisible();

    // Clean up, so a re-run starts from the same state.
    await panel.getByRole('button', { name: /^Remove bookmark/ }).first().click();
    await expect(panel.getByText(REMOTE_SELFTEST, { exact: false })).toHaveCount(0);
    await panel.getByRole('button', { name: 'close' }).click();
  });

  test('the address bar suggests pages that have been visited', async ({ page }) => {
    await signIn(page);
    // Visit the page first so it is in history, then look for it by fragment.
    await (await addressBar(page)).fill(REMOTE_SELFTEST);
    await (await addressBar(page)).press('Enter');
    await expect.poll(() => canvasHasContent(page), { timeout: 30_000 }).toBe(true);

    const bar = await addressBar(page);
    await bar.click();
    await bar.fill('selftest');
    // A suggestion list appears, and Enter on the highlighted row navigates.
    const suggestion = page.locator('ul li button', { hasText: '127.0.0.1' }).first();
    await expect(suggestion).toBeVisible({ timeout: 10_000 });
    await bar.press('ArrowDown');
    await bar.press('Enter');
    await expect(bar).toHaveValue(new RegExp('selftest'));
  });

  test('right-clicking the page opens Orbit\'s own context menu', async ({ page }) => {
    await signIn(page);
    await (await addressBar(page)).fill(REMOTE_SELFTEST);
    await (await addressBar(page)).press('Enter');
    await expect.poll(() => canvasHasContent(page), { timeout: 30_000 }).toBe(true);

    // Chromium's native menu can never appear in a screencast, so this menu is
    // built from what the server reports is under the pointer.
    await stage(page).click({ button: 'right', position: { x: 120, y: 120 } });
    const menu = page.getByRole('menu').filter({ hasText: 'Reload' });
    await expect(menu).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('Alt+T opens a tab and Alt+W closes it', async ({ page }) => {
    await signIn(page);
    const tabs = page.locator('div[title*="tab_"]');
    const initial = await tabs.count();

    // Orbit's shortcuts are on Alt: Ctrl+T and Ctrl+W belong to the browser the
    // client is running in and cannot be intercepted from a page.
    await stage(page).click({ position: { x: 60, y: 60 } });
    await page.keyboard.press('Alt+t');
    await expect(tabs).toHaveCount(initial + 1);

    await page.keyboard.press('Alt+w');
    await expect(tabs).toHaveCount(initial);
  });

  test('copy and paste work with the accelerator key', async ({ page, context }) => {
    /**
     * The reported regression: Ctrl/Cmd+C and Ctrl/Cmd+V did nothing.
     *
     * Two separate causes, both covered here - the remote browser needs an
     * explicit editing command for a copy, and paste has to come from *this*
     * machine's clipboard (the container's is a different clipboard entirely).
     * ControlOrMeta is Playwright's "whatever this platform's accelerator is".
     */
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signIn(page);
    await (await addressBar(page)).fill(REMOTE_SELFTEST);
    await (await addressBar(page)).press('Enter');
    await expect.poll(() => canvasHasContent(page), { timeout: 30_000 }).toBe(true);

    // Copy: select the remote page and copy it; the text must arrive here.
    // Chord and read together in the poll - one attempt can land before the page
    // has anything selectable, and retrying the read alone would never recover.
    await stage(page).click({ position: { x: 200, y: 200 } });
    await expect
      .poll(
        async () => {
          await page.keyboard.press('ControlOrMeta+a');
          await page.keyboard.press('ControlOrMeta+c');
          await page.waitForTimeout(400);
          return page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
        },
        { timeout: 20_000 },
      )
      .toContain('repaints:');

    // Paste: put a known string on this machine's clipboard and paste it into
    // the self-test page's input, which mirrors its value into the tab title.
    const marker = `orbit-paste-${Date.now()}`;
    await page.evaluate((text) => navigator.clipboard.writeText(text), marker);
    const canvas = (await page.locator('canvas').boundingBox())!;
    const frameWidth = await page.evaluate(async () => {
      const { state } = await (await fetch('/api/state')).json();
      return state.tabs.find((t: { url: string }) => t.url.includes('selftest'))?.width ?? 1;
    });
    // The input sits at 20,20 in page coordinates; the frame is scaled to fit.
    const fit = canvas.width / frameWidth;
    await page.mouse.click(canvas.x + 60 * fit, canvas.y + 38 * fit);
    await page.keyboard.press('ControlOrMeta+v');

    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const { state } = await (await fetch('/api/state')).json();
            return (state.tabs as { title: string }[]).map((t) => t.title).join(' | ');
          }),
        { timeout: 20_000 },
      )
      .toContain(marker);
  });

  test('keyboard capture is a per-tab toggle', async ({ page }) => {
    /**
     * Capture exists so this browser stops eating ⌘T/⌘W and the remote browser
     * gets them instead. Whether those specific chords arrive can only be
     * checked by a human pressing them - a synthetic key event was never going
     * to be intercepted by the host in the first place. What is checked here is
     * the machinery: the lock is taken, it is scoped to one tab, and there is a
     * way out that does not need the host's own shortcuts.
     */
    await signIn(page);
    const captured = page.getByRole('button', { name: /Keyboard captured/ });
    const fullscreen = () => page.evaluate(() => !!document.fullscreenElement);

    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: /Capture keyboard/ }).click();

    await expect(captured).toBeVisible();
    // 127.0.0.1 is a secure context, so the real lock is available here.
    await expect(captured).not.toContainText('partly');
    expect(await fullscreen()).toBe(true);

    // Switching tabs hands the keyboard back: capture is per tab.
    await page.getByRole('button', { name: 'New tab' }).click();
    const tabs = page.locator('div[title*="tab_"]');
    await tabs.last().click();
    await expect(captured).toHaveCount(0);
    // Polled, not read once: the badge goes as soon as state changes, while
    // handing the screen back is a promise that settles a tick later.
    await expect.poll(fullscreen, { timeout: 5_000 }).toBe(false);

    // Alt+K takes it and gives it back, without touching the host's chords.
    await stage(page).click({ position: { x: 60, y: 60 } });
    await page.keyboard.press('Alt+k');
    await expect(captured).toBeVisible();
    await page.keyboard.press('Alt+k');
    await expect(captured).toHaveCount(0);

    const last = tabs.last();
    await last.hover();
    await last.getByRole('button', { name: 'Close tab' }).click();
  });

  test('rejects a bad password without revealing whether the user exists', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Username').fill('definitely-not-a-user');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page.getByText('Incorrect username or password.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveCount(0);
  });
});
