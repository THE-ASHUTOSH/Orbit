/**
 * Stress and abuse harness.
 *
 * The benchmark next door answers "how fast is it under a normal load". This
 * answers a different question: "what happens when it is pushed, raced, or
 * broken". Every scenario therefore reports two things - the numbers it measured
 * and the invariants it checked - because a stress test that only prints
 * throughput cannot tell you whether the thing stayed *correct*.
 *
 * Nothing here is modelled. Frames are counted as they arrive, latency is one
 * clock (client send -> that eventId's ack), limits are read from the server, and
 * "did it survive" is a real request afterwards.
 *
 * Usage:
 *   npm run stress                      # everything
 *   STRESS_ONLY=heavy,races npm run stress
 *   USERS=16 TABS=8 BASE_URL=http://192.168.1.100:3030 npm run stress
 */
import { WebSocket } from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { decodeFrame, type ServerMessage } from '@orbit/protocol';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3030';
const USERNAME = process.env.BENCH_USER ?? process.env.ADMIN_USERNAME ?? 'admin';
const PASSWORD = process.env.BENCH_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'changeme';
const HEAVY_USERS = Number(process.env.USERS ?? 12);
const HEAVY_TABS = Number(process.env.TABS ?? 6);
const TARGET_URL = process.env.STRESS_TARGET ?? `${BASE_URL}/selftest`;
const ONLY = (process.env.STRESS_ONLY ?? '').split(',').filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const percentile = (v: number[], p: number) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]!);
};
const mean = (v: number[]) => (v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0);

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------

interface Check {
  what: string;
  ok: boolean;
  detail: string;
}
interface Scenario {
  name: string;
  measured: Record<string, unknown>;
  checks: Check[];
  seconds: number;
}

const scenarios: Scenario[] = [];
let current: Scenario | null = null;

function check(what: string, ok: boolean, detail = ''): void {
  current!.checks.push({ what, ok, detail });
  console.log(`   ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
}
function measure(values: Record<string, unknown>): void {
  Object.assign(current!.measured, values);
  for (const [k, v] of Object.entries(values)) console.log(`   · ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length && !ONLY.includes(name)) return;
  console.log(`\n▶ ${name}`);
  const startedAt = Date.now();
  current = { name, measured: {}, checks: [], seconds: 0 };
  scenarios.push(current);
  try {
    await fn();
  } catch (err) {
    check('scenario ran to completion', false, (err as Error).message);
  }
  current.seconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
  current = null;
}

// ---------------------------------------------------------------------------
// Server access
// ---------------------------------------------------------------------------

let cookie = '';

async function login(username = USERNAME, password = PASSWORD): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${username} (${res.status})`);
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  if (!raw) throw new Error('no session cookie');
  return raw.split(';')[0]!;
}

const api = async <T>(path: string, init?: RequestInit, as = cookie): Promise<T> => {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: as, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
};

interface StateTab {
  tabId: string;
  url: string;
  title: string;
  ownerId: string | null;
  viewers: string[];
  width: number;
  height: number;
}
const state = (as = cookie) => api<{ state: { tabs: StateTab[]; status: string; limits: { maxTabs: number } } }>('/api/state', undefined, as).then((r) => r.state);
const health = () => fetch(`${BASE_URL}/api/health`).then((r) => r.json() as Promise<{ status: string; tabs: number }>);
const metrics = () =>
  api<{ cpuPercent: number; rssBytes: number; framesPerSecond: number; bytesPerSecond: number; inputQueueDepth: number; droppedFrames?: number }>(
    '/api/metrics',
  );

// ---------------------------------------------------------------------------
// A client, with the counters a stress test needs
// ---------------------------------------------------------------------------

class Client {
  ws!: WebSocket;
  frames = 0;
  bytes = 0;
  framesByTab = new Map<string, number>();
  inputLatencies: number[] = [];
  errors: string[] = [];
  closed: { code: number; reason: string } | null = null;
  messages: ServerMessage[] = [];
  private pending = new Map<string, number>();
  private seq = 0;
  private openPromise!: Promise<void>;

  readonly name: string;
  /** The session this client authenticates with. */
  private readonly as: string;

  constructor(name: string, as = cookie) {
    this.name = name;
    this.as = as;
  }

  connect(): Promise<void> {
    this.ws = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/ws`, { headers: { Cookie: this.as } });
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (e) => {
        this.errors.push(e.message);
        reject(e);
      });
    });
    this.ws.on('close', (code, reason) => (this.closed = { code, reason: reason.toString() }));
    this.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.frames++;
        this.bytes += data.byteLength;
        const decoded = decodeFrame(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
        if (decoded) this.framesByTab.set(decoded.header.tabId, (this.framesByTab.get(decoded.header.tabId) ?? 0) + 1);
        return;
      }
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(msg);
      if (msg.type === 'input.ack') {
        const sentAt = this.pending.get(msg.eventId);
        if (sentAt !== undefined) {
          this.pending.delete(msg.eventId);
          this.inputLatencies.push(Date.now() - sentAt);
        }
      }
      if (msg.type === 'error') this.errors.push(msg.code);
    });
    return this.openPromise;
  }

  async ready(): Promise<Extract<ServerMessage, { type: 'hello' }>> {
    await this.openPromise;
    return this.wait('hello');
  }

  send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Raw send, for the abuse scenarios: no readyState guard, no envelope. */
  raw(data: string): void {
    try {
      this.ws.send(data);
    } catch (err) {
      this.errors.push((err as Error).message);
    }
  }

  input(msg: Record<string, unknown>): string {
    const eventId = `evt_${this.name}_${++this.seq}`;
    this.pending.set(eventId, Date.now());
    this.send({ ...msg, eventId, clientSequence: this.seq, clientSentAt: Date.now() });
    return eventId;
  }

  async type(tabId: string, text: string, gapMs = 8): Promise<void> {
    for (const ch of text) {
      const code = /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : `Digit${ch}`;
      this.input({ type: 'input.keyboard', event: 'keydown', tabId, key: ch, code, location: 0, repeat: false, modifiers: 0 });
      this.input({ type: 'input.keyboard', event: 'keyup', tabId, key: ch, code, location: 0, repeat: false, modifiers: 0 });
      if (gapMs) await sleep(gapMs);
    }
  }

  click(tabId: string, x: number, y: number): void {
    this.input({ type: 'input.mouse', event: 'mousemove', tabId, x, y, buttons: 0 });
    this.input({ type: 'input.mouse', event: 'mousedown', tabId, x, y, button: 'left', buttons: 1, clickCount: 1 });
    this.input({ type: 'input.mouse', event: 'mouseup', tabId, x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  wait<T extends ServerMessage['type']>(
    type: T,
    predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 20_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const poll = () => {
        const found = this.messages.filter((m) => m.type === type).find((m) => predicate(m as never));
        if (found) return resolve(found as never);
        if (Date.now() > deadline) return reject(new Error(`${this.name}: timed out waiting for ${type}`));
        setTimeout(poll, 20);
      };
      poll();
    });
  }

  seen<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m) => m.type === type) as never;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/** Open n clients on one session, all ready. */
async function fleet(prefix: string, n: number, as = cookie): Promise<Client[]> {
  const clients = Array.from({ length: n }, (_, i) => new Client(`${prefix}${i}`, as));
  await Promise.all(clients.map((c) => c.connect()));
  await Promise.all(clients.map((c) => c.ready()));
  return clients;
}

/** Create tabs through one client and return their ids. */
async function makeTabs(control: Client, count: number, label: string, url = TARGET_URL): Promise<string[]> {
  const before = new Set((await state()).tabs.map((t) => t.tabId));
  for (let i = 0; i < count; i++) control.send({ type: 'tab.create', url, label: `${label}-${i}` });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const now = (await state()).tabs.filter((t) => !before.has(t.tabId)).map((t) => t.tabId);
    if (now.length >= count || Date.now() > deadline) return now;
    await sleep(250);
  }
}

async function closeTabs(control: Client, tabIds: string[]): Promise<void> {
  for (const tabId of tabIds) control.send({ type: 'tab.close', tabId });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const open = new Set((await state()).tabs.map((t) => t.tabId));
    if (!tabIds.some((t) => open.has(t)) || Date.now() > deadline) return;
    await sleep(200);
  }
}

/** Sample /api/metrics while something else is happening. */
function sampler(intervalMs = 1000) {
  const samples: { cpu: number; rss: number; fps: number; bps: number; queue: number }[] = [];
  const timer = setInterval(async () => {
    try {
      const m = await metrics();
      samples.push({ cpu: m.cpuPercent, rss: m.rssBytes, fps: m.framesPerSecond, bps: m.bytesPerSecond, queue: m.inputQueueDepth });
    } catch {
      /* the server being too busy to answer is itself data; skip the sample */
    }
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return {
        cpuMean: mean(samples.map((s) => s.cpu)),
        cpuMax: samples.length ? Math.max(...samples.map((s) => s.cpu)) : 0,
        memoryGb: Number((mean(samples.map((s) => s.rss)) / 1e9).toFixed(2)),
        memoryGbMax: Number((Math.max(0, ...samples.map((s) => s.rss)) / 1e9).toFixed(2)),
        serverFps: mean(samples.map((s) => s.fps)),
        serverMbps: Number(((mean(samples.map((s) => s.bps)) * 8) / 1e6).toFixed(2)),
        queueMax: samples.length ? Math.max(...samples.map((s) => s.queue)) : 0,
        samples: samples.length,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** One person, one tab: the floor everything else is compared against. */
async function baseline(): Promise<void> {
  const control = new Client('base');
  await control.connect();
  await control.ready();
  const [tabId] = await makeTabs(control, 1, 'stress-base');
  if (!tabId) return check('a tab could be created', false);

  control.send({ type: 'tab.subscribe', tabId, width: 1280, height: 720 });
  await control.wait('stream.started', (m) => m.tabId === tabId);
  await sleep(1500);

  const s = sampler();
  const framesBefore = control.frames;
  const started = Date.now();
  const timer = setInterval(() => control.click(tabId, 300, 300), 250);
  await sleep(15_000);
  clearInterval(timer);
  const elapsed = (Date.now() - started) / 1000;
  const m = s.stop();

  measure({
    fps: Number(((control.frames - framesBefore) / elapsed).toFixed(1)),
    mbps: Number(((control.bytes * 8) / elapsed / 1e6).toFixed(2)),
    inputLatencyMs: { p50: percentile(control.inputLatencies, 0.5), p95: percentile(control.inputLatencies, 0.95), n: control.inputLatencies.length },
    server: m,
  });
  check('frames kept arriving', control.frames - framesBefore > 100, `${control.frames - framesBefore} frames in ${elapsed}s`);
  check('every input was acked', control.inputLatencies.length > 0 && control.errors.length === 0, control.errors.join(',') || 'no errors');

  await closeTabs(control, [tabId]);
  control.close();
}

/** Many people, many tabs, all of them animating. */
async function heavy(): Promise<void> {
  const control = new Client('heavy-ctl');
  await control.connect();
  await control.ready();
  const tabs = await makeTabs(control, HEAVY_TABS, 'stress-heavy');
  check(`${HEAVY_TABS} tabs opened`, tabs.length === HEAVY_TABS, `${tabs.length} created`);
  if (!tabs.length) return;
  await sleep(3000);

  const clients = await fleet('heavy', HEAVY_USERS);
  clients.forEach((c, i) => c.send({ type: 'tab.subscribe', tabId: tabs[i % tabs.length]!, width: 1280, height: 720 }));
  await sleep(2000);

  const s = sampler();
  const before = clients.map((c) => c.frames);
  const started = Date.now();
  const timer = setInterval(() => {
    clients.forEach((c, i) => {
      const tabId = tabs[i % tabs.length]!;
      const t = Date.now() / 1000;
      c.input({ type: 'input.mouse', event: 'mousemove', tabId, x: 300 + Math.round(200 * Math.sin(t + i)), y: 300 + Math.round(150 * Math.cos(t + i)), buttons: 0 });
      c.input({ type: 'input.keyboard', event: 'keydown', tabId, key: 'ArrowDown', code: 'ArrowDown', location: 0, repeat: false, modifiers: 0 });
    });
  }, 200);
  await sleep(30_000);
  clearInterval(timer);
  const elapsed = (Date.now() - started) / 1000;
  const m = s.stop();

  const gained = clients.map((c, i) => c.frames - before[i]!);
  const latencies = clients.flatMap((c) => c.inputLatencies);
  measure({
    users: clients.length,
    tabs: tabs.length,
    fpsPerClient: Number((mean(gained) / elapsed).toFixed(1)),
    worstClientFps: Number((Math.min(...gained) / elapsed).toFixed(1)),
    clientMbpsTotal: Number((clients.reduce((n, c) => n + c.bytes, 0) * 8 / elapsed / 1e6).toFixed(2)),
    inputLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), n: latencies.length },
    server: m,
  });
  check('every client received frames', gained.every((g) => g > 30), `min ${Math.min(...gained)} frames`);
  check('no client saw an error', clients.every((c) => c.errors.length === 0), [...new Set(clients.flatMap((c) => c.errors))].join(',') || 'none');
  check('input queue stayed shallow', m.queueMax < 50, `max depth ${m.queueMax}`);
  check('p95 input latency under 250ms', percentile(latencies, 0.95) < 250, `${percentile(latencies, 0.95)}ms`);

  clients.forEach((c) => c.close());
  await closeTabs(control, tabs);
  control.close();
}

/** Push every declared limit past its edge and see how it refuses. */
async function limits(): Promise<void> {
  const control = new Client('limit-ctl');
  await control.connect();
  await control.ready();
  const hello = await control.ready();
  const maxTabs = hello.state.limits.maxTabs;
  const open = (await state()).tabs.length;

  // --- tab limit ---
  const room = Math.max(0, maxTabs - open);
  const attempts = room + 4;
  for (let i = 0; i < attempts; i++) control.send({ type: 'tab.create', url: 'about:blank', label: `stress-limit-${i}` });
  await sleep(6000);
  const after = await state();
  const created = after.tabs.filter((t) => (t.title || '').length >= 0 && t.url === 'about:blank');
  measure({ maxTabs, tabsOpenAfterOverfill: after.tabs.length, refusals: control.errors.filter((e) => e === 'tab_limit').length });
  check('tab limit is enforced', after.tabs.length <= maxTabs, `${after.tabs.length} open, limit ${maxTabs}`);
  check('over-limit creates were refused, not ignored', control.errors.includes('tab_limit'), control.errors.join(',') || 'no tab_limit error');

  const mine = created.map((t) => t.tabId);
  await closeTabs(control, mine);

  // --- message rate ---
  const flooder = new Client('flood');
  await flooder.connect();
  await flooder.ready();
  const [floodTab] = (await state()).tabs.map((t) => t.tabId);
  for (let i = 0; i < 2000; i++)
    flooder.input({ type: 'input.mouse', event: 'mousemove', tabId: floodTab!, x: i % 500, y: i % 300, buttons: 0 });
  await sleep(3000);
  measure({ rateLimitErrors: flooder.errors.filter((e) => e === 'rate_limited').length, floodClosedWith: flooder.closed?.code ?? null });
  check('a flood is rate-limited or closed, not absorbed', flooder.errors.includes('rate_limited') || flooder.closed !== null, `errors=${flooder.errors.length} closed=${JSON.stringify(flooder.closed)}`);
  flooder.close();

  // --- malformed and oversized ---
  const abuser = new Client('abuse');
  await abuser.connect();
  await abuser.ready();
  abuser.raw('this is not json');
  abuser.raw(JSON.stringify({ type: 'nonsense.message', tabId: 'tab_01AAAA' }));
  abuser.raw(JSON.stringify({ type: 'input.mouse', tabId: 'not-a-tab-id', x: 'NaN' }));
  abuser.raw(JSON.stringify({ type: 'tab.navigate', tabId: floodTab, url: 'file:///etc/passwd', eventId: 'e', clientSequence: 1 }));
  await sleep(1500);
  const rejected = abuser.errors.filter((e) => e === 'invalid_message' || e === 'navigation_blocked');
  measure({ malformedRejections: rejected.length, abuserErrors: [...new Set(abuser.errors)] });
  check('garbage is rejected by code, not by crashing', rejected.length >= 2, rejected.join(','));

  // 2MB frame: over the socket's maxPayload, so the connection must be dropped.
  abuser.raw(JSON.stringify({ type: 'input.text', tabId: floodTab, text: 'x'.repeat(2 * 1024 * 1024), eventId: 'big', clientSequence: 2 }));
  await sleep(1500);
  measure({ oversizedClosedWith: abuser.closed?.code ?? null });
  check('an oversized message closes that one socket', abuser.closed !== null, JSON.stringify(abuser.closed));
  abuser.close();

  const h = await health();
  check('server still healthy after the abuse', h.status === 'running', JSON.stringify(h));
  control.close();
}

/** Create and destroy tabs continuously while other people are watching. */
async function churn(): Promise<void> {
  const control = new Client('churn-ctl');
  await control.connect();
  await control.ready();
  const [watchTab] = await makeTabs(control, 1, 'stress-churn-watch');
  const watcher = new Client('churn-watch');
  await watcher.connect();
  await watcher.ready();
  watcher.send({ type: 'tab.subscribe', tabId: watchTab!, width: 1280, height: 720 });
  await watcher.wait('stream.started', (m) => m.tabId === watchTab);
  await sleep(1000);

  const framesBefore = watcher.frames;
  const tabsAtStart = (await state()).tabs.length;
  const rounds = 12;
  const perRound = 3;
  const started = Date.now();
  for (let r = 0; r < rounds; r++) {
    const made = await makeTabs(control, perRound, `stress-churn-${r}`, 'about:blank');
    await closeTabs(control, made);
  }
  const elapsed = (Date.now() - started) / 1000;
  await sleep(1500);
  const tabsAtEnd = (await state()).tabs.length;

  measure({
    cycles: rounds * perRound,
    secondsPerCycle: Number((elapsed / (rounds * perRound)).toFixed(2)),
    tabsAtStart,
    tabsAtEnd,
    watcherFramesDuring: watcher.frames - framesBefore,
  });
  check('no tabs leaked', tabsAtEnd === tabsAtStart, `${tabsAtStart} -> ${tabsAtEnd}`);
  check("the bystander's stream was not disturbed", watcher.frames - framesBefore > 50, `${watcher.frames - framesBefore} frames`);
  check('no errors while churning', control.errors.length === 0 && watcher.errors.length === 0, [...control.errors, ...watcher.errors].join(',') || 'none');

  watcher.close();
  await closeTabs(control, [watchTab!]);
  control.close();
}

/**
 * The races. Each one is a real ordering hazard, driven deliberately rather than
 * hoped for - a stress test that only hammers throughput never finds these.
 */
async function races(): Promise<void> {
  const control = new Client('race-ctl');
  await control.connect();
  await control.ready();
  const [tabId] = await makeTabs(control, 1, 'stress-race');
  if (!tabId) return check('a tab could be created', false);
  await sleep(2000);

  // (a) Subscribing while the viewport is being resized. This is exactly the
  //     window where a joiner used to be dropped from the stream and freeze.
  let starved = 0;
  const attempts = 8;
  for (let i = 0; i < attempts; i++) {
    const sitting = new Client(`race-sit${i}`);
    await sitting.connect();
    await sitting.ready();
    sitting.send({ type: 'tab.subscribe', tabId, width: 1200 + i, height: 700 });
    await sitting.wait('stream.started', (m) => m.tabId === tabId);

    const joiner = new Client(`race-join${i}`);
    await joiner.connect();
    await joiner.ready();
    // Resize (which restarts the screencast) and subscribe at the same moment.
    sitting.send({ type: 'tab.resize', tabId, width: 900 + i * 37, height: 600 + i * 11 });
    await sleep(5 + i * 7);
    joiner.send({ type: 'tab.subscribe', tabId, width: 1000, height: 640 });
    await sleep(2500);

    const got = joiner.framesByTab.get(tabId) ?? 0;
    if (got < 2) starved++;
    sitting.close();
    joiner.close();
    await sleep(200);
  }
  measure({ resizeJoinAttempts: attempts, starvedJoiners: starved });
  check('a viewer joining mid-resize keeps receiving frames', starved === 0, `${starved}/${attempts} starved`);

  // (b) Closing a tab while somebody is still subscribing to it.
  const closeRace = await makeTabs(control, 4, 'stress-race-close', 'about:blank');
  const racers = await fleet('race-close', 4);
  closeRace.forEach((id, i) => {
    racers[i]!.send({ type: 'tab.subscribe', tabId: id, width: 900, height: 600 });
    control.send({ type: 'tab.close', tabId: id });
  });
  await sleep(3000);
  const leftOpen = (await state()).tabs.filter((t) => closeRace.includes(t.tabId));
  measure({ closeWhileSubscribing: closeRace.length, stillOpen: leftOpen.length });
  check('close wins cleanly against a concurrent subscribe', leftOpen.length === 0, `${leftOpen.length} left open`);
  check('a subscribe to a dying tab errors rather than hanging', racers.every((r) => r.closed === null), 'all sockets alive');
  racers.forEach((r) => r.close());

  // (c) Zoom and resize storm on one tab from two clients at once.
  const zoomA = new Client('race-zoomA');
  const zoomB = new Client('race-zoomB');
  await Promise.all([zoomA.connect(), zoomB.connect()]);
  await Promise.all([zoomA.ready(), zoomB.ready()]);
  zoomA.send({ type: 'tab.subscribe', tabId, width: 1280, height: 720 });
  zoomB.send({ type: 'tab.subscribe', tabId, width: 1280, height: 720 });
  await sleep(1200);
  const zoomFramesBefore = { a: zoomA.frames, b: zoomB.frames };
  for (let i = 0; i < 20; i++) {
    zoomA.send({ type: 'tab.zoom', tabId, zoom: 0.5 + (i % 6) * 0.25 });
    zoomB.send({ type: 'tab.resize', tabId, width: 800 + (i % 5) * 120, height: 600 + (i % 3) * 60 });
    await sleep(60);
  }
  await sleep(3000);
  const tabAfter = (await state()).tabs.find((t) => t.tabId === tabId);
  measure({
    zoomStormFramesA: zoomA.frames - zoomFramesBefore.a,
    zoomStormFramesB: zoomB.frames - zoomFramesBefore.b,
    finalViewport: tabAfter ? `${tabAfter.width}x${tabAfter.height}` : 'gone',
  });
  check('both clients still stream after a zoom/resize storm', zoomA.frames - zoomFramesBefore.a > 5 && zoomB.frames - zoomFramesBefore.b > 5, `A=${zoomA.frames - zoomFramesBefore.a} B=${zoomB.frames - zoomFramesBefore.b}`);
  check('the viewport ended in a sane state', !!tabAfter && tabAfter.width >= 240 && tabAfter.height >= 180, tabAfter ? `${tabAfter.width}x${tabAfter.height}` : 'tab gone');
  zoomA.close();
  zoomB.close();

  // (d) Subscribe/unsubscribe flapping: the stream must stop and restart cleanly
  //     without leaving a capture running for nobody.
  const flapper = new Client('race-flap');
  await flapper.connect();
  await flapper.ready();
  for (let i = 0; i < 25; i++) {
    flapper.send({ type: 'tab.subscribe', tabId, width: 1100, height: 700 });
    await sleep(40);
    flapper.send({ type: 'tab.unsubscribe', tabId });
    await sleep(30);
  }
  flapper.send({ type: 'tab.subscribe', tabId, width: 1100, height: 700 });
  await sleep(2500);
  const flapFrames = flapper.framesByTab.get(tabId) ?? 0;
  measure({ flapCycles: 25, framesAfterFlapping: flapFrames });
  check('flapping ends with a working stream', flapFrames > 2, `${flapFrames} frames`);
  flapper.close();

  const h = await health();
  check('server healthy after the races', h.status === 'running', JSON.stringify(h));
  await closeTabs(control, [tabId]);
  control.close();
}

/**
 * Six people typing into one tab at once: the arbiter's whole reason for
 * existing. Verified through the page itself - the self-test page mirrors its
 * input into the document title, so the server's own tab title is the receipt.
 */
async function inputIntegrity(): Promise<void> {
  const control = new Client('int-ctl');
  await control.connect();
  await control.ready();
  const [tabId] = await makeTabs(control, 1, 'stress-input');
  if (!tabId) return check('a tab could be created', false);
  control.send({ type: 'tab.subscribe', tabId, width: 1280, height: 720 });
  await control.wait('stream.started', (m) => m.tabId === tabId);
  await sleep(2500);

  // Focus the paste target at (20,20) on the self-test page.
  control.click(tabId, 60, 38);
  await sleep(400);

  const letters = ['a', 'b', 'c', 'd', 'e', 'f'];
  const each = 12;
  const typists = await fleet('typist', letters.length);
  const started = Date.now();
  await Promise.all(typists.map((c, i) => c.type(tabId, letters[i]!.repeat(each), 10)));
  const typingSeconds = Number(((Date.now() - started) / 1000).toFixed(1));
  await sleep(2500);

  const tab = (await state()).tabs.find((t) => t.tabId === tabId);
  const value = /pasted:(.*) self-test/.exec(tab?.title ?? '')?.[1] ?? '';
  const counts = Object.fromEntries(letters.map((l) => [l, [...value].filter((c) => c === l).length]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const latencies = typists.flatMap((c) => c.inputLatencies);

  measure({
    typists: typists.length,
    keystrokesSent: letters.length * each,
    keystrokesLanded: total,
    perLetter: counts,
    typingSeconds,
    inputLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), n: latencies.length },
  });
  check('every keystroke reached the page exactly once', total === letters.length * each, `${total}/${letters.length * each}`);
  check('no letter was lost or duplicated', letters.every((l) => counts[l] === each), JSON.stringify(counts));
  check('no input was refused', typists.every((c) => c.errors.length === 0), [...new Set(typists.flatMap((c) => c.errors))].join(',') || 'none');

  typists.forEach((c) => c.close());
  await closeTabs(control, [tabId]);
  control.close();
}

/**
 * Ownership under contention: several people asking for one tab at the same
 * moment, and the owner answering one of them. The invariant that matters is
 * that nobody types until they are told they may.
 */
async function ownership(): Promise<void> {
  const stamp = Date.now();
  const accounts = ['owner', 'ask1', 'ask2', 'ask3'].map((n) => `stress-${n}-${stamp}`);
  const password = 'stress-password-1';
  const created: string[] = [];

  try {
    for (const username of accounts) {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, password, role: 'user' }) });
      created.push(username);
    }
    const cookies = await Promise.all(accounts.map((u) => login(u, password)));
    const [ownerCookie, ...askerCookies] = cookies;

    const owner = new Client('owner', ownerCookie);
    await owner.connect();
    await owner.ready();
    const [tabId] = await makeTabs(owner, 1, 'stress-owned');
    if (!tabId) return check('the owner could open a tab', false);
    await sleep(1500);

    const askers = await Promise.all(
      askerCookies.map(async (c, i) => {
        const client = new Client(`asker${i}`, c);
        await client.connect();
        await client.ready();
        client.send({ type: 'tab.subscribe', tabId, width: 1100, height: 700 });
        await client.wait('tab.permissions', (m) => m.tabId === tabId);
        return client;
      }),
    );

    const permissions = askers.map((a) => a.seen('tab.permissions').at(-1)!.permission);
    check("everyone else is view-only on someone's tab", permissions.every((p) => p === 'view'), permissions.join(','));

    // All of them type at once. None of it may reach the page.
    await Promise.all(askers.map((a) => a.type(tabId, 'zzz', 5)));
    await sleep(1200);
    const refusals = askers.map((a) => a.errors.filter((e) => e === 'forbidden').length);
    check('view-only input is refused for all of them', refusals.every((n) => n > 0), refusals.join(','));

    // All of them ask at the same moment.
    askers.forEach((a) => a.send({ type: 'tab.access.request', tabId }));
    await sleep(1500);
    const requests = owner.seen('tab.access.requested').filter((r) => r.tabId === tabId);
    const uniqueAskers = new Set(requests.map((r) => r.userId));
    measure({ askers: askers.length, requestsDelivered: requests.length, distinctAskers: uniqueAskers.size });
    check('every request reached the owner', uniqueAskers.size === askers.length, `${uniqueAskers.size}/${askers.length}`);

    // A second ask inside the window must not double the prompts.
    askers.forEach((a) => a.send({ type: 'tab.access.request', tabId }));
    await sleep(1200);
    const afterRepeat = owner.seen('tab.access.requested').filter((r) => r.tabId === tabId).length;
    measure({ requestsAfterRepeatAsk: afterRepeat });
    check('repeat asks inside the window are suppressed', afterRepeat === requests.length, `${requests.length} -> ${afterRepeat}`);

    // Grant exactly one.
    const chosen = requests[0]!;
    owner.send({ type: 'tab.access.respond', tabId, userId: chosen.userId, grant: true });
    const grantedClient = askers.find((a) => a.seen('tab.permissions').at(-1) && a.messages.some((m) => m.type === 'tab.access.decided' && m.granted))!;
    await sleep(1500);

    const granted = askers.filter((a) => a.seen('tab.permissions').at(-1)?.permission === 'control');
    check('exactly one person was given control', granted.length === 1, `${granted.length} with control`);

    // The granted one can type; the others still cannot.
    const others = askers.filter((a) => a !== granted[0]);
    others.forEach((a) => (a.errors.length = 0));
    if (granted[0]) {
      granted[0].click(tabId, 60, 38);
      await sleep(300);
      await granted[0].type(tabId, 'ok', 10);
    }
    await Promise.all(others.map((a) => a.type(tabId, 'no', 5)));
    await sleep(2000);

    const tab = (await state()).tabs.find((t) => t.tabId === tabId);
    const value = /pasted:(.*) self-test/.exec(tab?.title ?? '')?.[1] ?? '';
    measure({ pageValue: value, refusalsAfterGrant: others.map((a) => a.errors.filter((e) => e === 'forbidden').length) });
    check('the granted user reaches the page', value.includes('ok'), `page shows "${value}"`);
    check('the others are still refused', others.every((a) => a.errors.includes('forbidden')), 'all refused');
    check('nothing they typed reached the page', !value.includes('no'), `page shows "${value}"`);
    void grantedClient;

    askers.forEach((a) => a.close());
    await closeTabs(owner, [tabId]);
    owner.close();
  } finally {
    const { users } = await api<{ users: { userId: string; username: string }[] }>('/api/admin/users');
    for (const u of users) if (created.includes(u.username)) await api(`/api/admin/users/${u.userId}`, { method: 'DELETE' });
  }
}

/** Kill Chromium mid-stream and time the recovery. */
async function recovery(): Promise<void> {
  const { execSync } = await import('node:child_process');
  /**
   * The browser process, not its renderers: killing a renderer is a different
   * (also handled) failure. `--` because the pattern starts with dashes.
   */
  const killCmd =
    process.env.STRESS_KILL_CMD ??
    `docker exec orbit sh -c 'pgrep -f -- --remote-debugging-port | head -1 | xargs -r kill -9'`;

  const control = new Client('rec-ctl');
  await control.connect();
  await control.ready();
  const [tabId] = await makeTabs(control, 1, 'stress-recovery');
  if (!tabId) return check('a tab could be created', false);
  control.send({ type: 'tab.subscribe', tabId, width: 1280, height: 720 });
  await control.wait('stream.started', (m) => m.tabId === tabId);
  await sleep(2000);
  const framesBeforeKill = control.frames;

  try {
    execSync(killCmd, { stdio: 'ignore' });
  } catch {
    return check('Chromium could be killed', false, `command failed: ${killCmd}`);
  }
  const killedAt = Date.now();

  // The client is told, and then told again when it is back.
  let sawCrashNotice = false;
  try {
    await control.wait('browser.status', (m) => m.status !== 'running', 15_000);
    sawCrashNotice = true;
  } catch {
    /* recovery can be quick enough that no non-running status is observed */
  }
  await control.wait('browser.status', (m) => m.status === 'running', 90_000);
  const recoveredMs = Date.now() - killedAt;

  // Re-subscribe the way a real client does on 'running', then check pixels flow.
  control.send({ type: 'tab.subscribe', tabId, width: 1280, height: 720 });
  await sleep(4000);
  const framesAfter = control.frames - framesBeforeKill;
  const tabs = (await state()).tabs;

  measure({ recoveredInMs: recoveredMs, sawCrashNotice, framesAfterRecovery: framesAfter, tabsAfter: tabs.length });
  check('clients were told the browser went away', sawCrashNotice, sawCrashNotice ? 'browser.status changed' : 'no non-running status seen');
  check('the browser came back', (await health()).status === 'running', `${recoveredMs}ms`);
  check('the tab id survived the crash', tabs.some((t) => t.tabId === tabId), tabId);
  check('frames resumed after recovery', framesAfter > 5, `${framesAfter} frames`);

  await closeTabs(control, [tabId]);
  control.close();
}

/** A longer run with more tabs than viewers, watching memory rather than speed. */
async function soak(): Promise<void> {
  const seconds = Number(process.env.STRESS_SOAK ?? 60);
  const control = new Client('soak-ctl');
  await control.connect();
  await control.ready();
  // As wide as asked for: the point of a soak is to hold the load, not to cap it.
  const want = Number(process.env.STRESS_SOAK_TABS ?? HEAVY_TABS);
  const tabs = await makeTabs(control, want, 'stress-soak');
  check(`${want} tabs opened`, tabs.length === want, `${tabs.length} of ${want}`);
  if (!tabs.length) return;

  const watchers = await fleet('soak', Math.max(4, Math.min(tabs.length, 8)));
  watchers.forEach((c, i) => c.send({ type: 'tab.subscribe', tabId: tabs[i % tabs.length]!, width: 1280, height: 720 }));
  await sleep(2000);

  const before = await metrics();
  const s = sampler(2000);
  const framesBefore = watchers.map((c) => c.frames);
  await sleep(seconds * 1000);
  const m = s.stop();
  const after = await metrics();
  const gained = watchers.map((c, i) => c.frames - framesBefore[i]!);

  measure({
    seconds,
    tabs: tabs.length,
    watchers: watchers.length,
    memoryGbStart: Number((before.rssBytes / 1e9).toFixed(2)),
    memoryGbEnd: Number((after.rssBytes / 1e9).toFixed(2)),
    server: m,
    framesPerWatcher: gained,
  });
  check('every watcher streamed throughout', gained.every((g) => g > seconds * 5), `min ${Math.min(...gained)}`);
  check('memory did not run away', after.rssBytes / 1e9 < 5.5, `${(after.rssBytes / 1e9).toFixed(2)} GB of a 6 GB cap`);
  check('no page crashed', watchers.every((c) => !c.errors.includes('page_crashed')), 'no page_crashed errors');

  watchers.forEach((c) => c.close());
  await closeTabs(control, tabs);
  control.close();
}

/**
 * Escalating load until something gives.
 *
 * One rung at a time - users and tabs together - measuring the same things at
 * each level so the numbers are comparable, and stopping early if the browser
 * stops being healthy. The point is not a single headline number but the shape
 * of the curve and the rung where an invariant first breaks.
 */
async function ladder(): Promise<void> {
  const rungs = (process.env.STRESS_LADDER ?? '4x2,12x6,24x12,40x20')
    .split(',')
    .map((r) => {
      const [users, tabs] = r.split('x').map(Number);
      return { users: users!, tabs: tabs! };
    });
  const rungSeconds = Number(process.env.STRESS_RUNG_SECONDS ?? 20);
  const results: Record<string, unknown>[] = [];
  let brokeAt: string | null = null;

  for (const rung of rungs) {
    const label = `${rung.users}u x ${rung.tabs}t`;
    const control = new Client(`ladder-ctl-${rung.users}`);
    await control.connect();
    await control.ready();

    // Reuse what is already open, then top up to the rung's width.
    const existing = (await state()).tabs.map((t) => t.tabId);
    const made = rung.tabs > existing.length ? await makeTabs(control, rung.tabs - existing.length, `stress-ladder-${rung.users}`) : [];
    const tabs = [...existing, ...made].slice(0, rung.tabs);
    await sleep(2500);

    const clients = await fleet(`ladder${rung.users}_`, rung.users);
    clients.forEach((c, i) => c.send({ type: 'tab.subscribe', tabId: tabs[i % tabs.length]!, width: 1280, height: 720 }));
    await sleep(2500);

    const s = sampler(1000);
    const framesBefore = clients.map((c) => c.frames);
    const started = Date.now();
    const timer = setInterval(() => {
      clients.forEach((c, i) => {
        const tabId = tabs[i % tabs.length]!;
        const t = Date.now() / 1000;
        c.input({ type: 'input.mouse', event: 'mousemove', tabId, x: 300 + Math.round(200 * Math.sin(t + i)), y: 300 + Math.round(150 * Math.cos(t + i)), buttons: 0 });
        c.input({ type: 'input.keyboard', event: 'keydown', tabId, key: 'ArrowDown', code: 'ArrowDown', location: 0, repeat: false, modifiers: 0 });
      });
    }, 200);
    await sleep(rungSeconds * 1000);
    clearInterval(timer);
    const elapsed = (Date.now() - started) / 1000;
    const m = s.stop();

    const gained = clients.map((c, i) => c.frames - framesBefore[i]!);
    const latencies = clients.flatMap((c) => c.inputLatencies);
    const errors = [...new Set(clients.flatMap((c) => c.errors))];
    const h = await health();
    const row = {
      rung: label,
      tabsOpen: tabs.length,
      fpsPerClient: Number((mean(gained) / elapsed).toFixed(1)),
      worstClientFps: Number((Math.min(...gained) / elapsed).toFixed(1)),
      silentClients: gained.filter((g) => g < 5).length,
      totalMbps: Number(((clients.reduce((n, c) => n + c.bytes, 0) * 8) / elapsed / 1e6).toFixed(1)),
      inputP50: percentile(latencies, 0.5),
      inputP95: percentile(latencies, 0.95),
      inputP99: percentile(latencies, 0.99),
      cpuMean: m.cpuMean,
      cpuMax: m.cpuMax,
      memoryGb: m.memoryGbMax,
      serverFps: m.serverFps,
      queueMax: m.queueMax,
      errors,
      browser: h.status,
    };
    results.push(row);
    console.log(`   · ${label}: ${row.fpsPerClient} fps/client (worst ${row.worstClientFps}), input p95 ${row.inputP95}ms, cpu ${row.cpuMean}%/${row.cpuMax}%, ${row.memoryGb}GB, ${row.silentClients} silent, ${row.errors.join(',') || 'no errors'}`);

    clients.forEach((c) => c.close());
    if (made.length) await closeTabs(control, made);
    control.close();
    await sleep(1500);

    if (row.silentClients > 0 || row.browser !== 'running') {
      brokeAt = label;
      break;
    }
  }

  measure({ rungs: results, brokeAt });
  const top = results[results.length - 1];
  check('every rung kept every client streaming', brokeAt === null, brokeAt ? `first broke at ${brokeAt}` : `held to ${top?.rung}`);
  check('input stayed responsive at the top rung', (top?.inputP95 as number) < 500, `p95 ${top?.inputP95}ms at ${top?.rung}`);
  check('memory stayed under the container cap', (top?.memoryGb as number) < 5.5, `${top?.memoryGb}GB at ${top?.rung}`);
  check('browser still healthy after the ladder', (await health()).status === 'running');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\nStress -> ${BASE_URL}`);
  cookie = await login();
  const before = await state();
  console.log(`starting with ${before.tabs.length} tab(s) open, browser ${before.status}\n`);

  await scenario('baseline', baseline);
  await scenario('heavy', heavy);
  await scenario('input-integrity', inputIntegrity);
  await scenario('ownership', ownership);
  await scenario('races', races);
  await scenario('limits', limits);
  await scenario('ladder', ladder);
  await scenario('soak', soak);
  await scenario('recovery', recovery);

  const after = await state();
  const h = await health();

  console.log(`\n${'─'.repeat(72)}`);
  console.log('SUMMARY');
  console.log('─'.repeat(72));
  let failed = 0;
  for (const s of scenarios) {
    const bad = s.checks.filter((c) => !c.ok);
    failed += bad.length;
    console.log(`${bad.length === 0 ? 'PASS' : 'FAIL'}  ${s.name.padEnd(16)} ${s.checks.length - bad.length}/${s.checks.length} checks  ${s.seconds}s`);
    for (const c of bad) console.log(`      ✗ ${c.what} — ${c.detail}`);
  }
  console.log('─'.repeat(72));
  console.log(`tabs open at start/end: ${before.tabs.length}/${after.tabs.length}   browser: ${h.status}`);
  console.log(`${failed === 0 ? 'all invariants held' : `${failed} invariant(s) broken`}`);
  console.log('─'.repeat(72));

  mkdirSync('bench-results', { recursive: true });
  const file = `bench-results/stress-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), target: BASE_URL, scenarios, tabsBefore: before.tabs.length, tabsAfter: after.tabs.length, health: h }, null, 2));
  console.log(`\nwrote ${file}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`stress harness failed: ${(err as Error).message}`);
  process.exit(2);
});
