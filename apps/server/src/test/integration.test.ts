/**
 * Integration test against a REAL Chromium.
 *
 * Boots the actual server (real CDP, real screencast, real input arbiter) on an
 * ephemeral port, serves test pages from a local http server so nothing here
 * needs the Internet, and drives it with several WebSocket clients at once.
 *
 * The subtests are named after the acceptance criteria in the README.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { ServerMessage, TabInfo } from '@orbit/protocol';

const dataDir = mkdtempSync(path.join(tmpdir(), 'orbit-itest-'));
const ADMIN_PASSWORD = 'integration-password';

// Environment must be in place before config.ts is imported.
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: process.env.ITEST_LOG ?? 'error',
  DATA_DIR: dataDir,
  DATABASE_URL: `file:${path.join(dataDir, 'app.db')}`,
  CHROMIUM_DATA_DIR: path.join(dataDir, 'profile'),
  DOWNLOAD_DIR: path.join(dataDir, 'downloads'),
  UPLOAD_DIR: path.join(dataDir, 'uploads'),
  APP_PORT: '0',
  SERVER_HOST: '127.0.0.1',
  // 0 = OS-assigned port, so a stray Chromium or a running dev server can
  // never make this suite talk to the wrong browser.
  CDP_PORT: '0',
  CHROMIUM_HEADLESS: 'true',
  SESSION_SECRET: 'integration-test-secret',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD,
  MDNS_ENABLED: 'false',
  MAX_FPS: '30',
  MAX_TABS: '10',
  VIEWPORT_WIDTH: '900',
  VIEWPORT_HEIGHT: '600',
});

const { startServer } = await import('../index.js');
const { createUser } = await import('../db.js');

// ---------------------------------------------------------------------------
// Local pages under test (keeps the whole suite offline)
// ---------------------------------------------------------------------------

const typed = new Map<string, string>();
const clicks = new Map<string, number>();

const PAGE = (id: string) => `<!doctype html>
<html><head><title>Test page ${id}</title></head>
<body style="margin:0;font:16px sans-serif;background:#fff">
  <input id="field" style="position:absolute;left:40px;top:40px;width:320px;height:40px;font-size:18px">
  <a id="popup" href="/page?id=popup" target="_blank"
     style="position:absolute;left:40px;top:140px;display:block;width:200px;height:30px">open popup</a>
  <button id="btn" style="position:absolute;left:40px;top:220px;width:200px;height:40px">click me</button>
  <script>
    const id = ${JSON.stringify(id)};
    const field = document.getElementById('field');
    field.addEventListener('input', () => {
      fetch('/report?id=' + id + '&v=' + encodeURIComponent(field.value));
    });
    document.getElementById('btn').addEventListener('click', () => {
      fetch('/click?id=' + id);
      // Rewrite the title the way a single-page app would, long after load.
      document.title = 'clicked ' + id;
    });
  </script>
</body></html>`;

const pageServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const id = url.searchParams.get('id') ?? '0';
  if (url.pathname === '/report') {
    typed.set(id, url.searchParams.get('v') ?? '');
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === '/click') {
    clicks.set(id, (clicks.get(id) ?? 0) + 1);
    res.writeHead(204).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE(id));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

class TestClient {
  readonly messages: ServerMessage[] = [];
  framesByTab = new Map<string, number>();
  private ws!: WebSocket;
  private seq = 0;
  private openPromise!: Promise<void>;

  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly cookie: string,
  ) {}

  connect(): Promise<void> {
    this.ws = new WebSocket(`${this.baseUrl.replace('http', 'ws')}/ws`, { headers: { Cookie: this.cookie } });
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected: ${res.statusCode}`)));
    });
    this.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const headerLen = data.readUInt16LE(2);
        const header = JSON.parse(data.subarray(4, 4 + headerLen).toString()) as { tabId: string };
        this.framesByTab.set(header.tabId, (this.framesByTab.get(header.tabId) ?? 0) + 1);
        return;
      }
      this.messages.push(JSON.parse(data.toString()) as ServerMessage);
    });
    return this.openPromise;
  }

  async ready(): Promise<Extract<ServerMessage, { type: 'hello' }>> {
    await this.openPromise;
    return this.waitForMessage('hello');
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendInput(msg: Record<string, unknown>): void {
    this.send({ ...msg, eventId: `evt_${this.name}_${++this.seq}`, clientSequence: this.seq, clientSentAt: Date.now() });
  }

  /** Type a string as real key events, the way a keyboard would. */
  async type(tabId: string, text: string): Promise<void> {
    for (const ch of text) {
      const code = /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : ch === ' ' ? 'Space' : `Digit${ch}`;
      for (const event of ['keydown', 'keyup'] as const) {
        this.sendInput({ type: 'input.keyboard', event, tabId, key: ch, code, location: 0, repeat: false, modifiers: 0 });
      }
      await sleep(12);
    }
  }

  async click(tabId: string, x: number, y: number): Promise<void> {
    this.sendInput({ type: 'input.mouse', event: 'mousemove', tabId, x, y, buttons: 0 });
    this.sendInput({ type: 'input.mouse', event: 'mousedown', tabId, x, y, button: 'left', buttons: 1, clickCount: 1 });
    this.sendInput({ type: 'input.mouse', event: 'mouseup', tabId, x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(60);
  }

  async waitForMessage<T extends ServerMessage['type']>(
    type: T,
    predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 15_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    return waitFor(
      `${this.name} message ${type}`,
      () => this.messages.filter((m) => m.type === type).find((m) => predicate(m as never)) as never,
      timeoutMs,
    );
  }

  seen<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m) => m.type === type) as never;
  }

  frames(tabId: string): number {
    return this.framesByTab.get(tabId) ?? 0;
  }

  close(): void {
    this.ws.close();
  }
  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
}

/**
 * Click until the page reports it. A single synthesised click can land while
 * Chromium is still settling after a navigation or popup, and retrying is what a
 * human would do - it keeps the assertion about "clicks work" instead of about
 * "clicks work on the first try within 400ms".
 */
async function clickUntil(
  client: TestClient,
  tabId: string,
  x: number,
  y: number,
  seen: () => unknown,
  attempts = 8,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    await client.click(tabId, x, y);
    for (let j = 0; j < 8; j++) {
      if (seen()) return;
      await sleep(50);
    }
  }
  throw new Error('the page never reported the click');
}

async function login(baseUrl: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login for ${username} should succeed`);
  const cookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))!;
  return cookie.split(';')[0]!;
}

// ---------------------------------------------------------------------------

test('orbit: end to end', async (t) => {
  const pagePort = await new Promise<number>((resolve) => {
    pageServer.listen(0, '127.0.0.1', () => resolve((pageServer.address() as { port: number }).port));
  });
  const pageUrl = (id: string) => `http://127.0.0.1:${pagePort}/page?id=${id}`;

  const server = await startServer();
  const base = server.url;

  t.after(async () => {
    await server.shutdown('test complete');
    pageServer.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitFor('chromium running', () => server.rt.browser.isReady, 45_000);

  // --- authentication ------------------------------------------------------

  await t.test('rejects bad credentials and unauthenticated sockets', async () => {
    const bad = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    assert.equal(bad.status, 401);

    const anon = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const failure = await new Promise<string>((resolve) => {
      anon.once('unexpected-response', (_r, res) => resolve(`status:${res.statusCode}`));
      anon.once('error', (err) => resolve(err.message));
      anon.once('open', () => resolve('opened'));
    });
    assert.match(failure, /401|Unauthorized/, 'an unauthenticated upgrade must be refused');
    anon.close();
  });

  const adminCookie = await login(base, 'admin', ADMIN_PASSWORD);
  createUser('bob', 'bob-password', 'user');
  createUser('carol', 'carol-password', 'user');
  createUser('vera', 'vera-password', 'viewer');
  const bobCookie = await login(base, 'bob', 'bob-password');
  const carolCookie = await login(base, 'carol', 'carol-password');
  const veraCookie = await login(base, 'vera', 'vera-password');

  // --- Tests 2-4: multiple clients, multiple tabs ---------------------------

  const alice = new TestClient('alice', base, adminCookie);
  const bob = new TestClient('bob', base, bobCookie);
  await Promise.all([alice.connect(), bob.connect()]);
  const aliceHello = await alice.ready();
  await bob.ready();

  assert.equal(aliceHello.state.status, 'running');
  assert.ok(aliceHello.state.tabs.length >= 1, 'a fresh browser starts with a tab');

  let tab1: TabInfo;
  let tab2: TabInfo;

  await t.test('Test 4: two tabs are created with distinct stable ids', async () => {
    alice.send({ type: 'tab.create', url: pageUrl('one'), label: 'tab-one' });
    const created1 = await alice.waitForMessage('tab.created', (m) => m.tab.label === 'tab-one');
    alice.send({ type: 'tab.create', url: pageUrl('two'), label: 'tab-two' });
    const created2 = await alice.waitForMessage('tab.created', (m) => m.tab.label === 'tab-two');

    tab1 = created1.tab;
    tab2 = created2.tab;
    assert.notEqual(tab1.tabId, tab2.tabId);
    assert.match(tab1.tabId, /^tab_[0-9A-Z]{22}$/, 'ids are prefixed ULIDs, not indexes');
    // Both clients learn about both tabs.
    await bob.waitForMessage('tab.created', (m) => m.tab.tabId === tab2.tabId);
  });

  // --- Test 5: one user per tab, both streaming ----------------------------

  await t.test('Test 5: two users subscribe to different tabs and both get frames', async () => {
    alice.send({ type: 'tab.subscribe', tabId: tab1.tabId, width: 900, height: 600 });
    bob.send({ type: 'tab.subscribe', tabId: tab2.tabId, width: 900, height: 600 });

    await alice.waitForMessage('stream.started', (m) => m.tabId === tab1.tabId);
    await bob.waitForMessage('stream.started', (m) => m.tabId === tab2.tabId);

    // Screencast is repaint-driven, so a loaded static page yields a frame on
    // start; continuous frames are asserted below once the page changes.
    await waitFor('alice frames', () => alice.frames(tab1.tabId) >= 1, 20_000);
    await waitFor('bob frames', () => bob.frames(tab2.tabId) >= 1, 20_000);

    // Clicking the page's button repaints it (and reports back), which proves
    // both that real mouse input arrives and that frames keep flowing.
    const aliceBefore = alice.frames(tab1.tabId);
    clicks.clear();
    await clickUntil(alice, tab1.tabId, 140, 240, () => clicks.get('one'));
    await waitFor('frames keep coming while the page changes', () => alice.frames(tab1.tabId) > aliceBefore, 15_000);

    // Streams are per tab: a subscriber to tab 1 must not receive tab 2 pixels.
    assert.equal(alice.frames(tab2.tabId), 0, 'no cross-tab frame delivery');
    assert.equal(bob.frames(tab1.tabId), 0);
  });

  // --- Tests 6 & 7: simultaneous work on different tabs --------------------

  await t.test('Tests 6+7: both users navigate and type simultaneously without crossing tabs', async () => {
    typed.clear();
    await Promise.all([alice.click(tab1.tabId, 120, 60), bob.click(tab2.tabId, 120, 60)]);
    await Promise.all([alice.type(tab1.tabId, 'alice'), bob.type(tab2.tabId, 'bob')]);

    const one = await waitFor('page one text', () => typed.get('one'));
    const two = await waitFor('page two text', () => typed.get('two'));
    assert.equal(one, 'alice', 'keystrokes landed in the real page in tab 1');
    assert.equal(two, 'bob', 'and independently in tab 2');

    // Simultaneous navigation, each tab going somewhere different.
    alice.send({ type: 'tab.navigate', tabId: tab1.tabId, url: pageUrl('one-b') });
    bob.send({ type: 'tab.navigate', tabId: tab2.tabId, url: pageUrl('two-b') });
    const nav1 = await alice.waitForMessage('tab.navigation', (m) => m.tabId === tab1.tabId && m.url.includes('one-b'));
    const nav2 = await bob.waitForMessage('tab.navigation', (m) => m.tabId === tab2.tabId && m.url.includes('two-b'));
    assert.ok(nav1.url.includes('id=one-b'));
    assert.ok(nav2.url.includes('id=two-b'));
    await waitFor('titles settle', () =>
      alice.seen('tab.navigation').some((m) => m.tabId === tab1.tabId && m.title.includes('one-b')),
    );
  });

  // --- Test 8: two users on the SAME tab ----------------------------------

  const carol = new TestClient('carol', base, carolCookie);

  await t.test('Test 8: two users control the same tab, server orders their input', async () => {
    await carol.connect();
    await carol.ready();
    carol.send({ type: 'tab.subscribe', tabId: tab1.tabId, width: 900, height: 600 });
    await carol.waitForMessage('stream.started', (m) => m.tabId === tab1.tabId);
    // Carol is the second subscriber to an already-running stream: she must get
    // an immediate keyframe rather than waiting for the page to repaint.
    await waitFor('carol keyframe', () => carol.frames(tab1.tabId) >= 1, 20_000);

    // Both users are told who is watching.
    await waitFor(
      'viewer list includes both',
      () =>
        alice
          .seen('tab.updated')
          .some((m) => m.tab.tabId === tab1.tabId && m.tab.viewers.length >= 2),
    );

    typed.clear();
    await alice.click(tab1.tabId, 120, 60);
    // Interleave keystrokes from two users into one tab.
    await Promise.all([alice.type(tab1.tabId, 'abc'), carol.type(tab1.tabId, 'xyz')]);

    const text = await waitFor('interleaved text', () => {
      const v = typed.get('one-b');
      return v && v.length >= 6 ? v : null;
    });
    assert.equal(text.length, 6, `both users' keystrokes reached the page: ${text}`);
    assert.deepEqual([...text].sort().join(''), 'abcxyz', 'no keystrokes were lost or duplicated');

    // Cursor presence is shared with the other viewer of the same tab.
    alice.send({ type: 'cursor', tabId: tab1.tabId, x: 300, y: 200, active: true });
    const cursors = await carol.waitForMessage('cursors', (m) => m.tabId === tab1.tabId && m.cursors.length > 0);
    assert.ok(cursors.cursors.some((c) => c.displayName === 'admin'));
  });

  await t.test('a right-click probe reports what is under the pointer, and paste reaches the page', async () => {
    // The context menu is built from this: Chromium's own menu is a native
    // popup and can never appear in a screencast.
    alice.send({ type: 'context.probe', tabId: tab1.tabId, x: 100, y: 150 });
    const onLink = await alice.waitForMessage('context.info', (m) => m.tabId === tab1.tabId);
    assert.match(onLink.link ?? '', /id=popup/, 'the anchor under the pointer was found');

    alice.send({ type: 'context.probe', tabId: tab1.tabId, x: 700, y: 500 });
    const onNothing = await alice.waitForMessage('context.info', (m) => m.tabId === tab1.tabId && m.link === null);
    assert.equal(onNothing.image, null, 'empty space reports no link and no image');

    // Paste: the client reads its own clipboard and sends the text, which is
    // inserted into the focused field of the real page.
    // On tab 2, so the caret this leaves behind cannot affect the later tests
    // that assert on tab 1's field.
    typed.clear();
    await bob.click(tab2.tabId, 120, 60);
    bob.send({ type: 'clipboard.write', tabId: tab2.tabId, text: 'pasted-from-a-viewer' });
    const value = await waitFor('pasted text', () => typed.get('two-b')?.includes('pasted') && typed.get('two-b'));
    assert.ok(value.includes('pasted-from-a-viewer'), `pasted text arrived intact: ${value}`);
  });

  // --- authorization -------------------------------------------------------

  await t.test('a viewer can watch but its input is refused server-side', async () => {
    const vera = new TestClient('vera', base, veraCookie);
    await vera.connect();
    await vera.ready();
    vera.send({ type: 'tab.subscribe', tabId: tab1.tabId, width: 900, height: 600 });
    const started = await vera.waitForMessage('stream.started', (m) => m.tabId === tab1.tabId);
    assert.ok(started.width > 0, 'viewers do get pixels');
    const perm = await vera.waitForMessage('tab.permissions', (m) => m.tabId === tab1.tabId);
    assert.equal(perm.permission, 'view');

    typed.clear();
    await vera.type(tab1.tabId, 'nope');
    const denial = await vera.waitForMessage('error', (m) => m.code === 'forbidden');
    assert.equal(denial.code, 'forbidden');
    await sleep(300);
    assert.equal(typed.get('one-b'), undefined, 'nothing a viewer typed reached the page');

    vera.send({ type: 'tab.create' });
    await vera.waitForMessage('error', (m) => m.code === 'forbidden');
    vera.close();
  });

  await t.test('per-tab grants are enforced (control downgraded to view)', async () => {
    const res = await fetch(`${base}/api/tabs/${tab2.tabId}/grants/${(await bobUserId(base, adminCookie))}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ permission: 'view' }),
    });
    assert.equal(res.status, 200);

    typed.clear();
    await bob.type(tab2.tabId, 'blocked');
    await bob.waitForMessage('error', (m) => m.code === 'forbidden');
    await sleep(300);
    assert.equal(typed.get('two-b'), undefined, 'a view-only grant blocks input');

    await fetch(`${base}/api/tabs/${tab2.tabId}/grants/${await bobUserId(base, adminCookie)}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    });
  });

  // --- popups --------------------------------------------------------------

  await t.test('Chromium opening a new target becomes an application tab', async () => {
    const before = alice.seen('tab.created').length;
    await alice.click(tab1.tabId, 100, 152); // the target=_blank link
    const created = await waitFor(
      'popup adopted',
      () => alice.seen('tab.created').slice(before).find((m) => m.tab.url.includes('id=popup')),
      20_000,
    );
    assert.match(created.tab.tabId, /^tab_/);
    // Everyone sees it, not just the user who clicked.
    await bob.waitForMessage('tab.created', (m) => m.tab.tabId === created.tab.tabId);
  });

  await t.test('a title rewritten by the page is reported (SPA titles)', async () => {
    // Chromium only announces titles on navigation, so this exercises the
    // injected observer - the path that silently reported an empty title until
    // it was fixed to re-report after the document is parsed.
    const seen = () =>
      alice.seen('tab.navigation').some((m) => m.tabId === tab1.tabId && m.title === 'clicked one-b');
    await clickUntil(alice, tab1.tabId, 140, 240, seen);
    assert.ok(seen(), 'the tab title followed document.title');
    const live = server.rt.tabs.get(tab1.tabId);
    assert.equal(live?.title, 'clicked one-b', 'and the authoritative state agrees');
  });

  // --- shared browser state -----------------------------------------------

  await t.test('cookies set in one tab are visible to the whole browser', async () => {
    const cookieName = `cbtest${Date.now()}`;
    await server.rt.browser.cdp.send(
      'Runtime.evaluate',
      { expression: `document.cookie = '${cookieName}=1; path=/'`, awaitPromise: false },
      server.rt.tabs.require(tab1.tabId).sessionId,
    );
    const summary = await server.rt.cookies.summarize();
    assert.ok(summary.some((d) => d.domain.includes('127.0.0.1')), 'the shared profile holds the cookie');
    // Values are never exposed, only counts.
    assert.equal(Object.keys(summary[0] ?? {}).includes('value'), false);
  });

  // --- Tests 9-10: disconnect and reconnect --------------------------------

  await t.test('Test 9: one user leaving does not disturb the browser or the others', async () => {
    const carolFramesBefore = carol.frames(tab1.tabId);
    alice.close();
    await sleep(600);

    assert.equal(server.rt.browser.status, 'running', 'the browser survives a client leaving');
    // Clicking repaints the page, proving carol's stream is still live.
    clicks.clear();
    await clickUntil(carol, tab1.tabId, 140, 240, () => clicks.get('one-b'));
    await waitFor('carol still streaming', () => carol.frames(tab1.tabId) > carolFramesBefore, 15_000);

    typed.clear();
    await carol.click(tab1.tabId, 120, 60);
    await carol.type(tab1.tabId, 'still-here');
    // The field already holds text from the same-tab test above, so assert the
    // suffix: what matters is that carol's keystrokes still arrive.
    const text = await waitFor('carol can still type', () => typed.get('one-b'));
    assert.ok(text.endsWith('still-here'), `expected carol's keystrokes at the end, got "${text}"`);

    const presence = await carol.waitForMessage(
      'presence',
      (m) => m.users.some((u) => u.username === 'admin' && u.state === 'reconnecting'),
      20_000,
    );
    assert.ok(presence.users.length >= 1, 'a dropped user shows as reconnecting, not vanished');
  });

  await t.test('Test 10: reconnecting restores the session and the previous tab', async () => {
    const again = new TestClient('alice2', base, adminCookie);
    await again.connect();
    const hello = await again.ready();
    assert.equal(hello.self.username, 'admin', 'the same session cookie is still valid');
    assert.equal(hello.self.currentTabId, tab1.tabId, 'the server remembers which tab this user was on');
    assert.ok(hello.state.tabs.some((t) => t.tabId === tab1.tabId));

    again.send({ type: 'tab.subscribe', tabId: hello.self.currentTabId!, width: 900, height: 600 });
    await waitFor('stream resumes after reconnect', () => again.frames(tab1.tabId) >= 1, 20_000);
    again.close();
  });

  // --- backpressure / limits ----------------------------------------------

  await t.test('malformed and over-rate messages are rejected, not crashed on', async () => {
    const client = new TestClient('rude', base, carolCookie);
    await client.connect();
    await client.ready();
    client.send({ type: 'input.mouse', tabId: 'nope' });
    await client.waitForMessage('error', (m) => m.code === 'invalid_message');

    for (let i = 0; i < 500; i++) client.send({ type: 'ping', t: i });
    const limited = await client.waitForMessage('error', (m) => m.code === 'rate_limited');
    assert.equal(limited.code, 'rate_limited');
    assert.ok(server.rt.browser.isReady, 'the browser is unaffected by a misbehaving client');
    client.close();
  });

  // --- Test 11: crash recovery --------------------------------------------

  await t.test('Test 11: killing Chromium is detected and recovered, tab ids preserved', async () => {
    const tabsBefore = server.rt.tabs.list().map((tb) => tb.tabId);
    const pid = server.rt.browser.pid!;
    assert.ok(pid, 'we know the chromium pid');

    process.kill(pid, 'SIGKILL');

    await carol.waitForMessage('browser.status', (m) => m.status !== 'running', 20_000);
    await waitFor('browser back up', () => server.rt.browser.isReady, 60_000);
    assert.ok(server.rt.browser.restarts >= 1);

    const tabsAfter = await waitFor(
      'tabs restored',
      () => {
        const ids = server.rt.tabs.list().map((tb) => tb.tabId);
        return ids.length >= tabsBefore.length ? ids : null;
      },
      30_000,
    );
    for (const id of tabsBefore) assert.ok(tabsAfter.includes(id), `tab ${id} survived the crash`);

    // And the recovered browser really works: type into a restored tab.
    const resumed = new TestClient('after-crash', base, adminCookie);
    await resumed.connect();
    await resumed.ready();
    resumed.send({ type: 'tab.subscribe', tabId: tab1.tabId, width: 900, height: 600 });
    await waitFor('frames after recovery', () => resumed.frames(tab1.tabId) >= 1, 30_000);
    typed.clear();
    await resumed.click(tab1.tabId, 120, 60);
    await resumed.type(tab1.tabId, 'recovered');
    const text = await waitFor('input works after recovery', () => typed.get('one-b'), 20_000);
    assert.equal(text, 'recovered');
    resumed.close();
  });

  await t.test('health and metrics report real numbers', async () => {
    const health = (await (await fetch(`${base}/api/health`)).json()) as { status: string; tabs: number };
    assert.equal(health.status, 'running');
    assert.ok(health.tabs >= 1);

    const metrics = (await (
      await fetch(`${base}/api/metrics`, { headers: { Cookie: adminCookie } })
    ).json()) as { tabs: number; uptimeSeconds: number; p95InputDispatchMs: number };
    assert.ok(metrics.uptimeSeconds >= 0);
    assert.ok(metrics.tabs >= 1);
    assert.ok(metrics.p95InputDispatchMs >= 0);
  });

  await t.test('profile and database live on the data volume', () => {
    assert.ok(existsSync(path.join(dataDir, 'profile')), 'chromium profile persisted outside the container fs');
    assert.ok(existsSync(path.join(dataDir, 'app.db')));
  });

  await t.test('graceful shutdown notifies clients and closes the browser', async () => {
    const watcher = new TestClient('watcher', base, adminCookie);
    await watcher.connect();
    await watcher.ready();
    const shutdownPromise = server.shutdown('SIGTERM');
    await watcher.waitForMessage('server.shutdown');
    await shutdownPromise;
    assert.equal(server.rt.browser.status, 'stopped');
    carol.close();
    bob.close();
  });
});

/** The admin API is the only place that maps usernames to ids. */
async function bobUserId(base: string, cookie: string): Promise<string> {
  const res = await fetch(`${base}/api/admin/users`, { headers: { Cookie: cookie } });
  const body = (await res.json()) as { users: { userId: string; username: string }[] };
  return body.users.find((u) => u.username === 'bob')!.userId;
}
