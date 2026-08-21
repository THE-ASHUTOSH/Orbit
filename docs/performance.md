# Performance

Every number here was produced by `npm run benchmark` against the Docker
Compose deployment on the machine described below. Nothing is estimated,
extrapolated or copied from another project. Re-run it and you will get numbers
for *your* hardware, which are the only ones that matter for your deployment.

## What is measured, and how

The interesting number is not frames per second, it is **how long after you move
your hand does the screen show it**. That is measured end to end, on one clock:

```
client sends input        t0   (client clock)
server receives it        ──►  input.ack.serverReceiveTime
server dispatches to CDP  ──►  input.ack.dispatchedAt
Chromium repaints         ──►  FrameHeader.capturedAt
client paints the frame   t1   (client clock)
```

- **Input latency** = ack received - `t0`. A full round trip through validation,
  authorization and the arbiter. One clock, no skew correction needed.
- **Interaction latency** = `t1` - `t0`, where `t1` is the arrival of the first
  frame whose `capturedAt >= dispatchedAt` - i.e. the first frame that can
  possibly contain the result of that input. Also one clock.
- **Queue time** = `dispatchedAt - serverReceiveTime`, entirely server-side.

The two cross-clock quantities the UI shows (`in`, and the clock offset itself)
are corrected using a ping/pong midpoint estimate, and are labelled as such. The
headline numbers avoid clock skew entirely by construction.

## Reference machine

| | |
|---|---|
| Host | Apple M5 Pro, 15 cores, 24 GB, macOS 26.5.2 |
| Docker | 29.6.1, container limited to **4 CPUs / 4 GiB** |
| Container | `node:24-slim` (Debian bookworm), Node 24.19, Chromium 151.0.7922.137 |
| Stream | 1280×720, JPEG quality 70, `MAX_FPS=30` |
| Page under test | `/selftest`, which repaints every 33ms - a deliberate worst case |
| Network | **loopback** (benchmark on the Docker host) |

**Read the last row carefully.** These runs isolate server and browser cost; they
do not include LAN transit. A wired LAN adds roughly 0.3-1ms RTT and Wi-Fi
typically 2-10ms with occasional spikes, which lands roughly linearly on the
interaction number. `cpuPercent` is a share of the container's 4-CPU allowance
(read from `cpu.max`), not of the 15-core host.

## Results

| Users | Tabs | Duration | FPS/client | Total Mbps | Input p50/p95 | Interaction p50/p95 | CPU mean/max | Memory | Max queue |
|---|---|---|---|---|---|---|---|---|---|
| 5 | 1 (shared) | 20s | 32.7 | 21.3 | 1 / 2 ms | **31 / 37 ms** | 18% / 20% | 0.87 GB | 0 |
| 10 | 5 | 30s | 31.9 | 41.0 | 1 / 2 ms | **26 / 44 ms** | 28% / 34% | 0.62 GB | 0 |
| 20 | 10 | 20s | 32.6 | 84.4 | 1 / 5 ms | **21 / 53 ms** | 58% / 61% | 0.89 GB | 0 |

Single viewer, one 720p30 tab: ~3.7 Mbps, ~30 fps sustained.

What this says:

- **Interaction latency is 21-31ms at the median and 37-53ms at p95** - inside the
  <100ms requirement, and around the <50ms stretch target, before LAN transit.
- **The arbiter is not the bottleneck.** Input latency stays at 1-5ms and the
  queue never grew beyond 0 even with 20 users, because mouse moves are coalesced
  rather than queued.
- **Cost is per streaming tab, not per user.** Ten tabs at 30fps is ~58% of 4
  CPUs (≈5-6% of one CPU per tab); the five extra *viewers* between the 10-user
  and 20-user runs are nearly free, since a frame is encoded once and fanned out.
- **Bandwidth is the real ceiling.** ~4 Mbps per 720p viewer. Twenty viewers is
  ~84 Mbps, which is comfortable on gigabit Ethernet and marginal on congested
  Wi-Fi. Tuning knobs below.

## Headed vs headless

Headless was the original default on the assumption that a headed browser would
only composite its focused window, freezing every other tab's stream. That
assumption was wrong: give each tab its own window
(`Target.createTarget({ newWindow: true })`) and both modes stream every tab
concurrently. Measured with 4 tabs subscribed simultaneously, 6s each:

| | headless | headed (Xvfb) |
|---|---|---|
| tabs streaming concurrently | 4/4 @ 30.2 fps | 4/4 @ 30.3 fps |

The real difference is cost, at 10 users / 5 tabs / 20s:

| | headless | headed (Xvfb) |
|---|---|---|
| FPS per client | 31.9 | 32.6 |
| Total Mbps | 41.0 | 42.9 |
| Input p50/p95 | 1 / 2 ms | 1 / 3 ms |
| Interaction p50/p95 | 26 / 44 ms | 32 / 50 ms |
| CPU mean/max | 28% / 34% | 40% / 49% |
| Memory | 0.62 GB | 1.32 GB |

Headed is the default anyway: roughly 40% more CPU, double the memory and ~6ms
more latency buys a browser that presents itself the way every other browser
does, which matters the moment a site runs bot detection. `CHROMIUM_HEADLESS=true`
takes the cheaper path when the sites in use do not care.

## Reproducing

```bash
docker compose up -d --build
BENCH_PASSWORD=... USERS=10 TABS=5 DURATION=30 npm run benchmark
```

Environment: `BASE_URL`, `USERS`, `TABS`, `DURATION`, `INPUT_INTERVAL`,
`BENCH_USER`, `BENCH_PASSWORD`, `BENCH_TARGET`. Results are written as JSON to
`bench/bench-results/`.

Point `BASE_URL` at the server's LAN IP **from another machine** to include real
network transit - that is the measurement that matches what users feel:

```bash
BASE_URL=http://192.168.1.100:3000 BENCH_PASSWORD=... npm run benchmark
```

`BENCH_TARGET` defaults to the server's own `/selftest` page, so the benchmark
needs no Internet access at all.

## Live numbers in the UI

Click **metrics** in the status bar: RTT, input, queue, total interaction latency,
plus fps, Mbps, CPU and memory for admins. Same instrumentation as the benchmark,
so what you see while using it is what the harness reports.

`GET /api/metrics` returns the same snapshot for scripting.

## Tuning

| Symptom | Knob | Note |
|---|---|---|
| Bandwidth too high | `STREAM_QUALITY` 70 → 50 | roughly halves bytes; text stays readable |
| Bandwidth too high | `VIEWPORT_WIDTH/HEIGHT` → 1024×640 | fewer pixels beats more compression for text |
| CPU too high | `MAX_FPS` 30 → 20 | proportional; 20fps still feels responsive for browsing |
| CPU too high | fewer *streamed* tabs | unwatched tabs cost nothing - unsubscribe rather than keep 20 open |
| Choppy on Wi-Fi | `BACKPRESSURE_BYTES` lower | drops stale frames sooner instead of buffering |
| Choppy on Wi-Fi | 5GHz / wired for the server | the server's uplink is the shared resource |
| Sluggish typing under load | check `inputQueueDepth` | if it is non-zero, the browser is the bottleneck, not the network |

Frames are never queued: a slow client is skipped for that frame and gets the
next one, so one bad Wi-Fi link cannot add latency for anyone else.

## Where the time goes

At p50 ≈ 26ms on the reference machine, roughly:

| Stage | ~ms | Notes |
|---|---|---|
| client → server, validate, authorize, queue | 1-2 | measured as input latency |
| Chromium input → repaint | 5-15 | the page's own work; varies wildly by site |
| JPEG encode (Chromium) | 3-8 | scales with viewport and quality |
| server relay (base64 → Buffer → socket) | <1 | one allocation, no re-encode |
| network | ~0 loopback, 0.3-10 LAN | add your own |
| `createImageBitmap` + canvas draw | 3-8 | off the main thread |
| frame pacing (waiting for the next capture) | 0-33 | the `MAX_FPS` interval; the largest single term |

The pacing term is why p95 sits well above p50: an input landing just after a
capture waits for the next one. Raising `MAX_FPS` shrinks it at a linear CPU cost.

## Honest limitations

- Measured on loopback; LAN transit is additive and not included.
- One machine, one Chromium. Numbers past ~20 concurrent viewers or ~10 streaming
  tabs on 4 CPUs are untested.
- The `/selftest` page repaints continuously. Real browsing is far cheaper -
  reading a page produces almost no frames - so these figures are a pessimistic
  bound, not a typical load.
- Apple Silicon with software rendering in a VM. x86 hardware with a GPU will
  behave differently; re-run the benchmark.
- No audio path exists, so no audio latency is measured.
