/**
 * Load and latency benchmark against a running server.
 *
 * Everything reported here is measured, never modelled:
 *
 *   inputLatency  client send  -> server ack for that exact eventId (round trip
 *                                 through the arbiter, one clock, no skew math)
 *   totalLatency  client send  -> first frame whose CDP capture timestamp is at
 *                                 or after the server dispatched that event
 *   fps / Mbps    frames and bytes actually received per stream
 *   cpu / memory  the server's own /api/metrics (cgroup-wide in Docker)
 *
 * Usage:
 *   npm run benchmark
 *   USERS=10 TABS=5 DURATION=30 BASE_URL=http://192.168.1.100:3000 npm run benchmark
 */
import { WebSocket } from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { decodeFrame, type ServerMessage } from '@orbit/protocol';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const USERS = Number(process.env.USERS ?? 10);
const TABS = Number(process.env.TABS ?? 5);
const DURATION_S = Number(process.env.DURATION ?? 30);
const USERNAME = process.env.BENCH_USER ?? process.env.ADMIN_USERNAME ?? 'admin';
const PASSWORD = process.env.BENCH_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'changeme';
// Defaults to the server's own animated self-test page: no Internet needed,
// and a repaint every frame, which is the heaviest case for the stream.
const TARGET_URL = process.env.BENCH_TARGET ?? `${BASE_URL}/selftest`;
const INPUT_INTERVAL_MS = Number(process.env.INPUT_INTERVAL ?? 250);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!);
}
const mean = (v: number[]) => (v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0);

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed (${res.status}) - check BENCH_USER/BENCH_PASSWORD`);
  const cookie = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  if (!cookie) throw new Error('no session cookie returned');
  return cookie.split(';')[0]!;
}

interface Client {
  index: number;
  ws: WebSocket;
  tabId: string | null;
  frames: number;
  bytes: number;
  inputLatencies: number[];
  totalLatencies: number[];
  errors: string[];
  pending: Map<string, number>;
  awaitFrame: { dispatchedAt: number; sentAt: number } | null;
  ready: Promise<void>;
}

function openClient(index: number, cookie: string): Client {
  const ws = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/ws`, { headers: { Cookie: cookie } });
  let resolveReady!: () => void;
  const client: Client = {
    index,
    ws,
    tabId: null,
    frames: 0,
    bytes: 0,
    inputLatencies: [],
    totalLatencies: [],
    errors: [],
    pending: new Map(),
    awaitFrame: null,
    ready: new Promise<void>((r) => (resolveReady = r)),
  };

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      client.frames++;
      client.bytes += data.byteLength;
      const decoded = decodeFrame(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      const waiting = client.awaitFrame;
      if (decoded && waiting && decoded.header.capturedAt >= waiting.dispatchedAt) {
        client.totalLatencies.push(Date.now() - waiting.sentAt);
        client.awaitFrame = null;
      }
      return;
    }
    const msg = JSON.parse(data.toString()) as ServerMessage;
    if (msg.type === 'hello') resolveReady();
    if (msg.type === 'input.ack') {
      const sentAt = client.pending.get(msg.eventId);
      if (sentAt !== undefined) {
        client.pending.delete(msg.eventId);
        client.inputLatencies.push(Date.now() - sentAt);
        client.awaitFrame = { dispatchedAt: msg.dispatchedAt, sentAt };
      }
    }
    if (msg.type === 'error') client.errors.push(msg.code);
  });
  ws.on('error', (err) => client.errors.push(err.message));
  return client;
}

const send = (c: Client, msg: unknown) => {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
};

let seq = 0;
function sendInput(c: Client, msg: Record<string, unknown>): void {
  const eventId = `evt_bench_${c.index}_${++seq}`;
  c.pending.set(eventId, Date.now());
  send(c, { ...msg, eventId, clientSequence: seq, clientSentAt: Date.now() });
}

async function main(): Promise<void> {
  console.log(`\nBenchmark -> ${BASE_URL}\n  users=${USERS} tabs=${TABS} duration=${DURATION_S}s\n`);
  const cookie = await login();

  // --- create tabs (one control connection) --------------------------------
  const control = openClient(-1, cookie);
  await control.ready;
  const tabIds: string[] = [];
  await new Promise<void>((resolve) => {
    control.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (msg.type === 'hello') for (const t of msg.state.tabs) if (!tabIds.includes(t.tabId)) tabIds.push(t.tabId);
      if (msg.type === 'tab.created' && !tabIds.includes(msg.tab.tabId)) tabIds.push(msg.tab.tabId);
      if (tabIds.length >= TABS) resolve();
    });
    for (let i = tabIds.length; i < TABS; i++) send(control, { type: 'tab.create', url: TARGET_URL, label: `bench-${i}` });
    setTimeout(resolve, 20_000);
  });
  const tabs = tabIds.slice(0, TABS);
  if (tabs.length < TABS) console.warn(`! only ${tabs.length}/${TABS} tabs available (MAX_TABS?)`);
  console.log(`tabs: ${tabs.join(', ')}`);
  // Give pages a moment to load before measuring steady-state streaming.
  await sleep(3000);

  // --- connect users -------------------------------------------------------
  const clients: Client[] = [];
  for (let i = 0; i < USERS; i++) {
    const c = openClient(i, cookie);
    c.tabId = tabs[i % tabs.length]!;
    clients.push(c);
  }
  await Promise.all(clients.map((c) => c.ready));
  for (const c of clients) send(c, { type: 'tab.subscribe', tabId: c.tabId, width: 1280, height: 720 });
  await sleep(1500);
  console.log(`${clients.length} clients subscribed; measuring for ${DURATION_S}s…\n`);

  // --- drive input ---------------------------------------------------------
  const startedAt = Date.now();
  const inputTimer = setInterval(() => {
    for (const c of clients) {
      if (!c.tabId) continue;
      const t = Date.now() / 1000;
      // A move plus a discrete event: the move exercises coalescing, the click
      // and key exercise the ack path and produce a visible pixel change.
      sendInput(c, {
        type: 'input.mouse',
        event: 'mousemove',
        tabId: c.tabId,
        x: 200 + Math.round(200 * Math.sin(t + c.index)),
        y: 200 + Math.round(150 * Math.cos(t + c.index)),
        buttons: 0,
      });
      sendInput(c, {
        type: 'input.keyboard',
        event: 'keydown',
        tabId: c.tabId,
        key: 'ArrowDown',
        code: 'ArrowDown',
        location: 0,
        repeat: false,
        modifiers: 0,
      });
      sendInput(c, {
        type: 'input.keyboard',
        event: 'keyup',
        tabId: c.tabId,
        key: 'ArrowDown',
        code: 'ArrowDown',
        location: 0,
        repeat: false,
        modifiers: 0,
      });
    }
  }, INPUT_INTERVAL_MS);

  const samples: { cpu: number; rss: number; fps: number; bps: number; queue: number }[] = [];
  const metricsTimer = setInterval(async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/metrics`, { headers: { Cookie: cookie } });
      if (!res.ok) return;
      const m = (await res.json()) as {
        cpuPercent: number;
        rssBytes: number;
        framesPerSecond: number;
        bytesPerSecond: number;
        inputQueueDepth: number;
      };
      samples.push({ cpu: m.cpuPercent, rss: m.rssBytes, fps: m.framesPerSecond, bps: m.bytesPerSecond, queue: m.inputQueueDepth });
    } catch {
      /* server busy; skip this sample */
    }
  }, 2000);

  await sleep(DURATION_S * 1000);
  clearInterval(inputTimer);
  clearInterval(metricsTimer);
  const elapsed = (Date.now() - startedAt) / 1000;

  // --- report --------------------------------------------------------------
  const inputLatencies = clients.flatMap((c) => c.inputLatencies);
  const totalLatencies = clients.flatMap((c) => c.totalLatencies);
  const frames = clients.reduce((n, c) => n + c.frames, 0);
  const bytes = clients.reduce((n, c) => n + c.bytes, 0);
  const errors = clients.flatMap((c) => c.errors);

  const report = {
    at: new Date().toISOString(),
    target: BASE_URL,
    config: { users: USERS, tabs: tabs.length, durationSeconds: Math.round(elapsed), inputIntervalMs: INPUT_INTERVAL_MS },
    streams: {
      framesReceived: frames,
      averageFpsPerClient: Number((frames / elapsed / clients.length).toFixed(1)),
      clientMbps: Number(((bytes * 8) / elapsed / 1e6).toFixed(2)),
    },
    inputLatencyMs: {
      samples: inputLatencies.length,
      mean: mean(inputLatencies),
      p50: percentile(inputLatencies, 0.5),
      p95: percentile(inputLatencies, 0.95),
      p99: percentile(inputLatencies, 0.99),
      max: inputLatencies.length ? Math.max(...inputLatencies) : 0,
    },
    interactionLatencyMs: {
      samples: totalLatencies.length,
      mean: mean(totalLatencies),
      p50: percentile(totalLatencies, 0.5),
      p95: percentile(totalLatencies, 0.95),
      p99: percentile(totalLatencies, 0.99),
    },
    server: {
      cpuPercentMean: mean(samples.map((s) => s.cpu)),
      cpuPercentMax: samples.length ? Math.max(...samples.map((s) => s.cpu)) : 0,
      memoryGbMean: Number((mean(samples.map((s) => s.rss)) / 1e9).toFixed(2)),
      serverFpsMean: mean(samples.map((s) => s.fps)),
      serverMbpsMean: Number(((mean(samples.map((s) => s.bps)) * 8) / 1e6).toFixed(2)),
      inputQueueDepthMax: samples.length ? Math.max(...samples.map((s) => s.queue)) : 0,
    },
    errors: [...new Set(errors)],
  };

  console.log('─'.repeat(58));
  console.log(`Users:                    ${report.config.users}`);
  console.log(`Tabs:                     ${report.config.tabs}`);
  console.log(`Duration:                 ${report.config.durationSeconds}s`);
  console.log(`Average FPS per client:   ${report.streams.averageFpsPerClient}`);
  console.log(`Client-side throughput:   ${report.streams.clientMbps} Mbps (all clients)`);
  console.log(`Input latency  mean/p50/p95/p99: ${report.inputLatencyMs.mean}/${report.inputLatencyMs.p50}/${report.inputLatencyMs.p95}/${report.inputLatencyMs.p99} ms (n=${report.inputLatencyMs.samples})`);
  console.log(`Interaction    mean/p50/p95/p99: ${report.interactionLatencyMs.mean}/${report.interactionLatencyMs.p50}/${report.interactionLatencyMs.p95}/${report.interactionLatencyMs.p99} ms (n=${report.interactionLatencyMs.samples})`);
  console.log(`Server CPU mean/max:      ${report.server.cpuPercentMean}% / ${report.server.cpuPercentMax}%`);
  console.log(`Server memory:            ${report.server.memoryGbMean} GB`);
  console.log(`Server stream rate:       ${report.server.serverFpsMean} fps, ${report.server.serverMbpsMean} Mbps`);
  console.log(`Max input queue depth:    ${report.server.inputQueueDepthMax}`);
  if (report.errors.length) console.log(`Errors seen:              ${report.errors.join(', ')}`);
  console.log('─'.repeat(58));

  mkdirSync('bench-results', { recursive: true });
  const file = `bench-results/bench-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${file}\n`);

  for (const c of clients) c.ws.close();
  control.ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`benchmark failed: ${(err as Error).message}`);
  process.exit(1);
});
