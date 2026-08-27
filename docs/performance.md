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
BASE_URL=http://192.168.1.100:3030 BENCH_PASSWORD=... npm run benchmark
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

## Stress and abuse

`./orbit stress` pushes rather than measures: nine scenarios, each reporting
numbers **and** invariants. Everything below is from one run on a 6-core / 6 GB
container, with every tab on the self-test page - which repaints continuously and
is therefore the most expensive page there is. Real browsing, where pages sit
still most of the time, is far cheaper.

### The load ladder

Users and tabs raised together, 20s per rung, every tab animating:

| Users x tabs | fps per client | worst client | input p95 | CPU mean/max | memory |
|---|---|---|---|---|---|
| 8 x 4 | 27.1 | 17.6 | 3 ms | 39% / 62% | 2.3 GB |
| 20 x 10 | 12.6 | 6.3 | 16 ms | 59% / 74% | 2.5 GB |
| 40 x 20 | 6.8 | 4.3 | 11 ms | 69% / 100% | 4.2 GB |
| 50 x 20 | 0.3 | 0.3 | 106 ms | 88% / 99% | 3.5 GB |

Read the shape, not the peak. **Interaction stays responsive far past the point
where the picture does**: at 40 users on 20 animating tabs input still acks in
11 ms p95, while the frame rate has fallen to ~7 fps per client because six cores
cannot composite and JPEG-encode twenty continuously-repainting pages. Nobody
ever went silent, no errors were returned, memory peaked at 4.2 GB of 6 GB, and
the input queue never grew past zero.

The practical ceiling on this box is therefore **CPU on frame production**, and
it is reached by tab count far sooner than by user count: 20 idle tabs cost
almost nothing, 20 animating ones cost everything. `MAX_FPS` and `STREAM_QUALITY`
are the two dials that buy it back.

### Steady state

| Scenario | Result |
|---|---|
| 1 user, 1 tab, 15s | 30.3 fps, 10.1 Mbps, input p50 1 ms / p95 2 ms, CPU 10% |
| 16 users, 10 tabs, 30s | 14.1 fps/client (worst 13.8), 69 Mbps total, input p50 2 / p95 6 / p99 24 ms, CPU 55%, 2.7 GB |
| 16 tabs, 8 watchers, 120s soak | every watcher streamed throughout, memory 3.04 -> 3.55 GB, no page crashed |

### Correctness under pressure

| What was done | What held |
|---|---|
| 6 people typing into one tab at once | all 72 keystrokes reached the page, 12 of each letter - none lost, none duplicated (read back from the page itself) |
| 3 people asking one owner for control simultaneously | every request delivered, repeats inside the window suppressed, exactly one granted, the other two still refused and nothing they typed reached the page |
| A viewer subscribing while the viewport resizes, x8 | 0 starved (this is the race that used to freeze the second viewer) |
| Closing 4 tabs while 4 clients subscribe to them | all closed cleanly, no socket dropped, and the loser of the race now gets `tab_not_found` instead of `internal` |
| 20 zoom/resize messages from two clients at once | both kept streaming, viewport ended sane (1706x880) |
| 25 subscribe/unsubscribe flaps | stream working at the end |
| 24 tab creates against a limit of 20 | exactly 20 open, 4 refused with `tab_limit` |
| 2000 input messages in a burst | rate-limited, then the connection closed 1008 |
| Garbage JSON, unknown types, bad tab ids, `file://` navigation | refused by code (`invalid_message`, `navigation_blocked`), server healthy |
| A 2 MB message | that one socket closed 1009, nothing else affected |
| `SIGKILL` on Chromium mid-stream | clients told, browser back in **1.6 s**, tab ids preserved, frames resumed |

### What this run does not cover

- **`MAX_USERS`** (50 *distinct* people) - the harness drives many sockets from
  one account, which is deliberately not the same gate.
- **A slow client**, i.e. the frame-dropping backpressure path: hard to simulate
  honestly from Node, which drains sockets as fast as it can.
- **Heavy real pages** (image galleries, video) - the self-test page is a
  worst-case *repainter* but a trivial *renderer*.
- **A hostile LAN**: everything here runs over loopback, so the numbers exclude
  real network transit. Point `BASE_URL` at the LAN address from another machine
  to include it.

## Sharpness

Measured on a text-heavy page at 1080p, on the reference machine.

**Codec: no.** JPEG at quality 100 against lossless PNG, same page, same scale:

| Codec | Detail (Laplacian variance) | KB/frame | Mbps | CPU |
|---|---|---|---|---|
| JPEG q100 | 8481 | 56 | 13.9 | 7.3% |
| PNG | 8559 (+0.9%) | 80 | 19.8 | 7.1% |

PNG costs 43% more bandwidth to deliver under 1% more detail: at quality 100
JPEG is already close to lossless on screen content. On a photographic page the
two were within 10% on bytes and 0.6% on detail. There is deliberately no codec
switch - the stream is JPEG and `STREAM_QUALITY` is the dial.

**Device scale factor: yes, for retina clients.**

| DEVICE_SCALE_FACTOR | Frame | Detail, 1x grid | Detail, retina grid | KB/frame | Mbps | CPU |
|---|---|---|---|---|---|---|
| 1 | 1920x912 | 8481 | 421 | 56 | 13.8 | 7.2% |
| 2 | 3840x1824 | 7502 (-12%) | 2996 (+7.1x) | 147 | 36.6 | 17.2% |

Both feeds are judged on the same display grid, because raw variance is not
comparable across resolutions: "1x grid" is what a plain monitor shows, "retina
grid" is what a 2x panel shows - where a 1x feed gets upscaled and a 2x feed
lands 1:1. So at 2 a retina viewer sees roughly seven times the fine detail,
while a 1x viewer sees a slightly softer image for 2.6x the bytes.

The default is 1, and the setting is a dial rather than a switch: any value from
1 to 3 works, fractions included. The value worth using follows from the client,
not from taste -

    useful DSF = (canvas CSS width x client devicePixelRatio) / VIEWPORT_WIDTH

- because past that ratio the frame carries pixels the panel cannot show. On a
retina laptop that is around 1.3 windowed and 1.8 maximised, which is why 2 was
measurably oversupplying by ~55% in the run above. `1.5` is verified end to end
(frame 2880 wide, `--force-device-scale-factor=1.5`, screen 3840x2160); its
bandwidth sits between the two rows and is not separately measured.

It is browser-wide and applied at launch, so it cannot be a per-viewer setting
without restarting Chromium - `Emulation` cannot move it per tab, as below.

Two traps this cost real time, both worth keeping written down:

- CDP's `Emulation.setDeviceMetricsOverride` takes a `deviceScaleFactor`, and
  setting it *looks* like it works - the page reports the new
  `devicePixelRatio` - while frames keep arriving at 1920x912 and slightly
  softer, because the page renders at 2x and is squeezed back into a 1x window
  surface. The scale of a captured surface is a launch-time property, so
  `--force-device-scale-factor` is what changes it. `launchargs.test.ts` pins
  that flag so the knob cannot go back to reporting success and doing nothing.
- The Xvfb screen must scale with it (`MAX_VIEWPORT_* x DSF`, done in
  `docker-entrypoint.sh`), or the window is clipped and the capture comes back
  black - the same failure as a viewport larger than its screen, below.

## Geometry: one rule, and never bigger than the screen

A tab's viewport comes from a single function (`viewportFor` in `TabManager.ts`)
used by both `tab.subscribe` and `tab.resize`. Before that they disagreed -
subscribe honoured `PIN_VIEWPORT`, resize did not - so a tab's resolution flipped
between the pinned size and the client's raw window depending on which message
landed last, and changed again after every refresh.

Three properties, all tested:

- **Pinned means pinned.** With `PIN_VIEWPORT=1` the width is always
  `VIEWPORT_WIDTH`; only the aspect follows the viewer's window.
- **Snapped down to a 16px grid.** A window two pixels taller must not produce a
  different viewport, a stream restart and a subtly different page. Down rather
  than nearest, because rounding up overshoots the area available - and on a
  headed browser overshooting the screen is what turns a frame black.
- **Never larger than the screen.** A window cannot exceed the screen it is on,
  and a screencast of a viewport larger than its window is captured as solid
  black. Measured: at 50% zoom the viewport grew to 2560x1216 on a 1920x1080
  virtual screen and every frame came back 100% black. The entrypoint now sizes
  Xvfb from `MAX_VIEWPORT_*`, and the server clamps to whatever the screen
  actually is, so the two cannot disagree.

A stream restart (zoom, resize, recovery) also sends every viewer one keyframe
immediately. Screencast frames are repaint-driven, so a page sitting still used
to leave a blank canvas until something on it moved - the "it goes black until I
reload the page inside" report.

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
