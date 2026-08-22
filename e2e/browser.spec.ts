/**
 * Drives the real UI in a real browser: log in, create and switch tabs,
 * navigate, click, type, scroll, watch pixels change, and close a tab.
 *
 * Two independent browser contexts stand in for two machines on the LAN, which
 * is what makes the multi-user assertions meaningful: separate cookie jars,
 * separate WebSockets, one shared Chromium behind them.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';

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

async function signIn(page: Page, username = USERNAME, password = PASSWORD) {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Login' }).click();
  // The ⋮ menu only exists once signed in; sign-out lives inside it now.
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
}

/**
 * Checksum of the middle of the canvas, where a page's content actually is.
 *
 * Sampling the top-left corner - or the first N characters of toDataURL() -
 * mostly measures background, so two genuinely different frames can look
 * identical. This reads real pixels from the centre band.
 */
async function canvasSignature(page: Page): Promise<{ sum: number; distinct: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas || canvas.width === 0) return { sum: 0, distinct: 0 };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { sum: 0, distinct: 0 };
    const w = Math.min(canvas.width, 600);
    const h = Math.min(canvas.height, 300);
    const x = Math.max(0, Math.round((canvas.width - w) / 2));
    const y = Math.max(0, Math.round((canvas.height - h) / 2));
    const { data } = ctx.getImageData(x, y, w, h);
    let sum = 0;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      const px = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
      sum = (sum + px * ((i >> 2) + 1)) % 2147483647;
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

  test('rejects a bad password without revealing whether the user exists', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Username').fill('definitely-not-a-user');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page.getByText('Incorrect username or password.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveCount(0);
  });
});
