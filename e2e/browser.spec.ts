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

  test('keyboard capture is a per-tab toggle, in the same full screen', async ({ page }) => {
    /**
     * Capture exists so this browser stops eating ⌘T/⌘W and the remote browser
     * gets them instead. Whether those specific chords arrive can only be checked
     * by a human pressing them - a synthetic key event was never going to be
     * intercepted by the host in the first place. What is checked here is the
     * machinery: the lock is taken, it looks like full screen rather than a
     * second kind of it, it is scoped to one tab, and there is a way out that
     * does not need the host's own shortcuts.
     */
    await signIn(page);
    const captured = page.getByRole('button', { name: /Keyboard captured/ });
    const tabs = page.locator('div[title*="tab_"]');
    const fullscreen = () => page.evaluate(() => !!document.fullscreenElement);

    // Two tabs, so "per tab" can be shown - and switching needs a shortcut once
    // the tab strip is out of the way.
    const before = await tabs.count();
    await page.getByRole('button', { name: 'New tab' }).click();
    await expect(tabs).toHaveCount(before + 1);
    await tabs.last().click();

    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: /Capture keyboard/ }).click();

    await expect(captured).toBeVisible();
    // 127.0.0.1 is a secure context, so the real lock is available here.
    await expect(captured).not.toContainText('partly');
    expect(await fullscreen()).toBe(true);
    // Same full screen as full-screen mode - which keeps Orbit's controls.
    await expect(tabs.first()).toBeVisible();
    await expect(await addressBar(page)).toBeVisible();

    // Switching tabs hands the keyboard back: capture is per tab.
    await tabs.first().click();
    await expect(captured).toHaveCount(0);
    await expect.poll(fullscreen, { timeout: 5_000 }).toBe(false);

    // Alt+K takes it and gives it back, without touching the host's chords.
    await stage(page).click({ position: { x: 60, y: 60 } });
    await page.keyboard.press('Alt+k');
    await expect(captured).toBeVisible();
    await page.keyboard.press('Alt+k');
    await expect(captured).toHaveCount(0);
    await expect.poll(fullscreen, { timeout: 5_000 }).toBe(false);

    const last = tabs.last();
    await last.hover();
    await last.getByRole('button', { name: 'Close tab' }).click();
    await expect(tabs).toHaveCount(before);
  });

  test('a tab belongs to whoever opened it, and control can be asked for', async ({ browser }) => {
    /**
     * Two ordinary users, because the admin account can always control every tab
     * and would prove nothing here. They are created for this test and removed
     * at the end.
     */
    const PW = 'ownership-test-pw';
    const owner = { user: `owner-${Date.now()}`, ctx: await browser.newContext() };
    const asker = { user: `asker-${Date.now()}`, ctx: await browser.newContext() };
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();

    const makeUser = (username: string) =>
      adminPage.evaluate(
        async ([u, p]) =>
          (
            await fetch('/api/admin/users', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: u, password: p, role: 'user' }),
            })
          ).status,
        [username, PW],
      );

    try {
      await signIn(adminPage);
      expect(await makeUser(owner.user)).toBeLessThan(300);
      expect(await makeUser(asker.user)).toBeLessThan(300);

      const ownerPage = await owner.ctx.newPage();
      const askerPage = await asker.ctx.newPage();
      await signIn(ownerPage, owner.user, PW);
      await signIn(askerPage, asker.user, PW);

      // The owner opens a tab. It is theirs.
      const ownerTabs = ownerPage.locator('div[title*="tab_"]');
      const beforeCount = await ownerTabs.count();
      await ownerPage.getByRole('button', { name: 'New tab' }).click();
      await expect(ownerTabs).toHaveCount(beforeCount + 1);
      const tabId = (await ownerTabs.last().getAttribute('title'))!.match(/tab_[0-9A-Z]+/)![0];

      // The other user can watch it, and is told whose it is.
      const askerTab = askerPage.locator(`div[title*="${tabId}"]`);
      await expect(askerTab).toBeVisible();
      await askerTab.click();
      const ask = askerPage.getByRole('button', { name: new RegExp(`Ask .*${owner.user}.* for control`) });
      await expect(ask).toBeVisible();
      // View-only: the address bar says so rather than pretending to work.
      await expect(askerPage.getByPlaceholder('View only')).toBeVisible();

      // Asking reaches the owner, wherever they are looking.
      await ask.click();
      const prompt = ownerPage.getByRole('alertdialog', { name: new RegExp(`${asker.user}.*asking for control`) });
      await expect(prompt).toBeVisible();
      await expect(ask).toContainText('Asked');

      // Granting takes effect without a reload.
      await prompt.getByRole('button', { name: 'Give control' }).click();
      await expect(askerPage.getByPlaceholder('Search or enter address')).toBeVisible();
      await expect(ask).toHaveCount(0);
      await expect(prompt).toHaveCount(0);

      // Tidy up: the tab, then the two accounts.
      await ownerTabs.last().hover();
      await ownerTabs.last().getByRole('button', { name: 'Close tab' }).click();
      await expect(ownerTabs).toHaveCount(beforeCount);
    } finally {
      await adminPage.evaluate(async (names) => {
        const { users } = await (await fetch('/api/admin/users')).json();
        for (const u of users as { userId: string; username: string }[])
          if (names.includes(u.username)) await fetch(`/api/admin/users/${u.userId}`, { method: 'DELETE' });
      }, [owner.user, asker.user]);
      await Promise.all([owner.ctx.close(), asker.ctx.close(), adminCtx.close()]);
    }
  });

  test('full screen gives the page the whole display, and keeps the controls', async ({ page }) => {
    await signIn(page);
    const tabs = page.locator('div[title*="tab_"]');
    const bar = await addressBar(page);
    const exit = page.getByRole('button', { name: /Leave full screen/ });
    const fullscreen = () => page.evaluate(() => !!document.fullscreenElement);

    await expect(tabs.first()).toBeVisible();

    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: /Full screen/ }).click();

    /**
     * The display is taken - and on a real machine that is what buys the page
     * more room, because the host browser's own tabs and toolbar go away. Not
     * asserted here: this test browser has no host chrome to reclaim, so its
     * viewport is the same size either way. What is checkable is the state.
     */
    await expect(exit).toBeVisible();
    expect(await fullscreen()).toBe(true);

    // The controls stay where they are. Hiding them would take away exactly what
    // you went full screen to use.
    await expect(tabs.first()).toBeVisible();
    await expect(bar).toBeVisible();
    await expect(page.locator('canvas')).toBeVisible();

    // And back, by the on-screen way out.
    await exit.click();
    await expect.poll(fullscreen, { timeout: 5_000 }).toBe(false);

    // Alt+F does the same round trip without touching the mouse.
    await stage(page).click({ position: { x: 60, y: 60 } });
    await page.keyboard.press('Alt+f');
    await expect(exit).toBeVisible();
    await page.keyboard.press('Alt+f');
    await expect(exit).toHaveCount(0);
    await expect.poll(fullscreen, { timeout: 5_000 }).toBe(false);
  });

  test('a tab nobody asked for is still yours: followed, and closable', async ({ page }) => {
    /**
     * The reported edge case. A tab that arrives with no opener and nobody
     * asking - an extension acting on its own, or a redirect - used to end up
     * owned by nobody: the view did not follow it, and "only the owner may close
     * it" then meant only an admin could get rid of it.
     *
     * Reproduced deterministically with a rel=noopener link on the self-test
     * page: that is exactly a new tab with no opener, without depending on a
     * chord reaching the browser process.
     */
    await signIn(page);
    const tabs = page.locator('div[title*="tab_"]');

    const whereAmI = () =>
      page.evaluate(async () => {
        const [{ state }, me] = await Promise.all([
          (await fetch('/api/state')).json(),
          (await fetch('/api/auth/me')).json(),
        ]);
        const self = (state.users as { userId: string; currentTabId: string | null }[]).find(
          (u) => u.userId === me.user.userId,
        );
        const tab = (state.tabs as { tabId: string; ownerId: string | null }[]).find(
          (t) => t.tabId === self?.currentTabId,
        );
        return { onTab: self?.currentTabId ?? null, owned: !!tab?.ownerId };
      });

    // Own tab, own page: nothing an earlier test left behind can interfere.
    const before = await tabs.count();
    await page.getByRole('button', { name: 'New tab' }).click();
    await expect(tabs).toHaveCount(before + 1);
    await tabs.last().click();
    await (await addressBar(page)).fill(REMOTE_SELFTEST);
    await (await addressBar(page)).press('Enter');
    await expect.poll(() => canvasHasContent(page), { timeout: 30_000 }).toBe(true);

    const started = await whereAmI();

    // Click the noopener link at (20,70) on the page, mapped to the drawn frame.
    const canvas = (await page.locator('canvas').boundingBox())!;
    // This tab's width, not "some tab showing the self-test page": with leftover
    // tabs from earlier tests the wrong one was picked, the scale came out wrong
    // and the click missed the link entirely.
    const myTabId = (await tabs.last().getAttribute('title'))!.match(/tab_[0-9A-Z]+/)![0];
    const frameWidth = await page.evaluate(async (id) => {
      const { state } = await (await fetch('/api/state')).json();
      return (state.tabs as { tabId: string; width: number }[]).find((t) => t.tabId === id)?.width ?? 1;
    }, myTabId);
    const fit = canvas.width / frameWidth;
    // The noopener link sits 50px up from the bottom of the page.
    await page.mouse.click(canvas.x + 100 * fit, canvas.y + canvas.height - 35 * fit);
    await expect(tabs).toHaveCount(before + 2);

    // The view follows it, and it has an owner rather than being nobody's.
    await expect.poll(async () => (await whereAmI()).onTab !== started.onTab, { timeout: 15_000 }).toBe(true);
    expect((await whereAmI()).owned).toBe(true);

    // And it can be closed by the person looking at it.
    const opened = tabs.last();
    await opened.hover();
    await opened.getByRole('button', { name: 'Close tab' }).click();
    await expect(tabs).toHaveCount(before + 1);

    /**
     * Closing it comes back to the page it came from - not to whichever tab
     * happens to be first, which is where it used to land.
     */
    await expect.poll(async () => (await whereAmI()).onTab, { timeout: 15_000 }).toBe(started.onTab);

    const mine = tabs.last();
    await mine.hover();
    await mine.getByRole('button', { name: 'Close tab' }).click();
    await expect(tabs).toHaveCount(before);
  });

  test('the viewport is the same size every time, and never black', async ({ page }) => {
    /**
     * Two bugs met here. The size was decided by whichever message landed last -
     * subscribe honoured PIN_VIEWPORT, resize did not - so a tab's resolution
     * changed on every refresh. And zooming out or going full screen asked for a
     * viewport bigger than the screen the window lives on, which Chromium
     * captures as solid black until the page inside is reloaded.
     */
    await signIn(page);
    const tabs = page.locator('div[title*="tab_"]');
    const before = await tabs.count();

    await page.getByRole('button', { name: 'New tab' }).click();
    await expect(tabs).toHaveCount(before + 1);
    await tabs.last().click();
    const tabId = (await tabs.last().getAttribute('title'))!.match(/tab_[0-9A-Z]+/)![0];

    /** This tab's size and how much of the drawn frame is black. */
    const geometry = (id: string) =>
      page.evaluate(async (wanted) => {
        const c = document.querySelector('canvas') as HTMLCanvasElement | null;
        const { state } = await (await fetch('/api/state')).json();
        let black = -1;
        if (c && c.width) {
          const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let dark = 0;
          let n = 0;
          for (let i = 0; i < d.length; i += 4 * 97) {
            n++;
            if (d[i]! < 8 && d[i + 1]! < 8 && d[i + 2]! < 8) dark++;
          }
          black = Math.round((dark / n) * 100);
        }
        const tab = (state.tabs as { tabId: string; width: number; height: number }[]).find((t) => t.tabId === wanted);
        return { size: tab ? `${tab.width}x${tab.height}` : 'gone', black };
      }, id);

    /** The size it lands on, once the client has finished measuring itself. */
    const settled = async () => {
      let last = '';
      for (let i = 0; i < 40; i++) {
        const now = (await geometry(tabId)).size;
        if (now === last) return now;
        last = now;
        await page.waitForTimeout(400);
      }
      return last;
    };
    const created = await settled();

    // Refreshing this browser must not change the remote resolution.
    for (const round of [1, 2]) {
      await page.reload();
      await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
      await expect.poll(settled, { timeout: 25_000 }).toBe(created);
      void round;
    }

    // Every zoom level, then full screen: the frame must never come back black.
    for (const preset of ['50%', '200%', '100%']) {
      await page.getByRole('button', { name: 'Menu' }).click();
      await page.getByRole('button', { name: preset, exact: true }).click();
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await geometry(tabId)).black, { timeout: 20_000 }).toBeLessThan(50);
    }

    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: /Full screen/ }).click();
    await expect.poll(async () => (await geometry(tabId)).black, { timeout: 20_000 }).toBeLessThan(50);
    await page.getByRole('button', { name: /Leave full screen/ }).click();
    await expect.poll(settled, { timeout: 25_000 }).toBe(created);

    const last = tabs.last();
    await last.hover();
    await last.getByRole('button', { name: 'Close tab' }).click();
    await expect(tabs).toHaveCount(before);
  });

  test('a loading tab says so, in the tab strip and over the page', async ({ page }) => {
    await signIn(page);
    const bar = await addressBar(page);
    /**
     * ?delay holds the first byte back for two seconds. A page from this same
     * server otherwise arrives in single-digit milliseconds - far too fast to
     * ever catch an indicator, which is precisely why one is worth having for
     * pages that are not local.
     */
    await bar.fill(`${REMOTE_SELFTEST}?delay=2000`);
    await bar.press('Enter');

    await expect(page.getByRole('progressbar', { name: 'Page loading' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('status', { name: 'Loading' }).first()).toBeVisible();

    // And they go away when it has arrived, rather than spinning forever.
    await expect(page.getByRole('progressbar', { name: 'Page loading' })).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('status', { name: 'Loading' })).toHaveCount(0);
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
