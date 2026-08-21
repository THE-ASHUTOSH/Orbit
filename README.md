# Orbit

One real Chromium, shared over your LAN, where several people work in **different
tabs at the same time** - or in the same tab together, with each other's cursors
visible.

Not a remote desktop and not a screenshot poller. The application understands
*tabs*: each tab is streamed independently straight out of Chromium, so four
people can be on four different pages of one browser session, sharing one cookie
jar, one set of logins, one profile.

```
                          LOCAL NETWORK
   Laptop A          Laptop B          Phone C          Tablet D
      │                 │                 │                │
      └─────────────────┴──── :3000 ──────┴────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │  auth · presence   │
                    │  tabs · input      │
                    │  arbiter · streams │
                    └─────────┬──────────┘
                       private CDP (loopback)
                    ┌─────────┴──────────┐
                    │      Chromium      │
                    │  ┌────┐  ┌────┐    │
       User A ──────┼─►│Tab1│  │Tab2│◄───┼────── User B
                    │  └────┘  └────┘    │
                    │  ┌────┐  ┌────┐    │
       User C ──────┼─►│Tab3│  │Tab4│◄───┼────── User D
                    │  └────┘  └────┘    │
                    └────────────────────┘
```

## Quick start

```bash
./orbit up
```

That generates `.env` on first run (random signing secret, admin password you
type), builds, starts, waits for the browser to be healthy, and prints the LAN
URL to share. Open it from any device on the network and sign in.

Prefer doing it by hand? `cp .env.example .env`, set `SESSION_SECRET`
(`openssl rand -hex 32`) and `ADMIN_PASSWORD`, then `docker compose up --build` -
`./orbit` is a convenience wrapper, never a requirement.
The server prints its address on startup; `ip -4 addr` (Linux),
`ipconfig getifaddr en0` (macOS) or `ipconfig` (Windows) will also tell you.

Requirements: Docker with Compose v2, ~4 CPUs and 4 GB for the container, and one
open inbound TCP port. No Internet connection is needed once the image is built.

## What works

**Tabs.** Create, close, switch, navigate, reload, back/forward, duplicate,
rename, live URL/title/loading state. Popups and `target="_blank"` are adopted
automatically and appear for everyone. Every tab has a stable id (`tab_01M0G7…`),
never an array index, and keeps it across a browser crash.

**Simultaneous users, different tabs.** Input is routed by user + tab + session.
Nothing crosses tabs - there is a test that proves it.

**Simultaneous users, same tab.** No locking, no turn-taking. A per-tab
server-side arbiter gives one authoritative order, coalesces mouse moves, and
de-duplicates retries. Other people's cursors are drawn with their names.

**Real input.** Mouse move/down/up/click/double-click/right-click/wheel/drag,
touch, full keyboard with modifiers and shortcuts, IME composition, and paste.
Enter submits, Backspace deletes, Ctrl+A selects - because key events carry
proper virtual key codes, not just characters.

**Shared, persistent state.** One Chromium profile on a Docker volume: cookies,
logins, localStorage, IndexedDB and history survive restarts, and a login in one
tab is a login in every tab.

**Presence and reconnection.** Heartbeats, online/idle/reconnecting states, and a
jittered-backoff reconnect that restores your session and your previous tab. One
client leaving never disturbs the browser or anyone else.

**Crash recovery.** Chromium dying is detected, restarted with exponential
backoff, and tabs come back with their ids intact.

**Auth and authorization.** Username/password with `scrypt`, server-side
sessions, `HttpOnly` signed cookies, authenticated WebSocket upgrades, and
`admin`/`user`/`viewer` roles plus per-tab `view`/`control`/`admin` grants -
enforced server-side, not by hiding buttons.

**Files and clipboard.** Downloads listed and fetchable; a page's file dialog is
answered from an upload directory the page can never escape; clipboard sync in
both directions, permission-gated.

**Admin view.** Browser status, CPU/memory, per-tab detail, live metrics, user
management, disconnect, browser restart, cookie domains, audit log.

**Measured performance.** Not claimed - measured, with the harness included.

## Performance

From `npm run benchmark` against the Compose deployment (Apple M5 Pro, container
limited to 4 CPUs, 1280×720 @ 30fps, JPEG q70, loopback):

| Users | Tabs | FPS/client | Total Mbps | Input p50/p95 | **Interaction p50/p95** | CPU | Memory |
|---|---|---|---|---|---|---|---|
| 5 | 1 (shared) | 32.7 | 21.3 | 1 / 2 ms | **31 / 37 ms** | 18% | 0.87 GB |
| 10 | 5 | 31.9 | 41.0 | 1 / 2 ms | **26 / 44 ms** | 28% | 0.62 GB |
| 20 | 10 | 32.6 | 84.4 | 1 / 5 ms | **21 / 53 ms** | 58% | 0.89 GB |

"Interaction" is what you actually feel: from sending an input event to painting
the first frame that can contain its result, measured on one clock. LAN transit is
additive and not included - run the benchmark from another machine to include it.
Methodology, limits and tuning knobs: [docs/performance.md](docs/performance.md).

## How it works

Chromium is a child of the server process, driven over the DevTools Protocol on
**loopback only** - port 9222 is never published, never on a Docker network, and
no request path forwards a raw CDP command.

Frames come from `Page.startScreencast` **per page target**, which is what makes
per-tab collaboration possible at all: a desktop-capture + WebRTC design gives
you one opaque screen, and handing each user a different tab would mean
reimplementing a window manager. Frames are relayed as binary WebSocket messages
and painted to a canvas via `createImageBitmap`. Pacing is done by delaying the
frame ack, so Chromium throttles itself at the source instead of encoding frames
nobody will see. A client that falls behind loses frames rather than accumulating
stale ones.

Input goes the other way through a per-tab FIFO arbiter, so "two people typing at
once" means both are accepted concurrently and the server picks one order.

Full reasoning, including the options rejected and what each choice costs:
[docs/decisions.md](docs/decisions.md).

## Documentation

| | |
|---|---|
| [architecture.md](docs/architecture.md) | components, data flow, failure behaviour, scale-out seams |
| [decisions.md](docs/decisions.md) | ADRs: streaming, input, sync, lifecycle, discovery, auth, persistence |
| [protocol.md](docs/protocol.md) | every message, the input envelope, the binary frame format |
| [performance.md](docs/performance.md) | how latency is measured, results, tuning |
| [security.md](docs/security.md) | threat model, CDP containment, hardening, limitations |
| [deployment.md](docs/deployment.md) | LAN setup per OS, firewall, volumes, backup, Internet mode |
| [troubleshooting.md](docs/troubleshooting.md) | symptom → cause → fix |

## Project layout

```
apps/server/src
  index.ts              bootstrap, static frontend, graceful shutdown
  runtime.ts            composition root; file chooser, downloads, page hooks
  config.ts  log.ts  db.ts  metrics.ts  mdns.ts
  auth/                 password (scrypt), sessions, permissions
  api/                  REST routes, origin validation
  ws/hub.ts             connections, presence, routing, authorization
  browser/
    BrowserManager.ts   Chromium process: launch, health, restart, shutdown
    TabManager.ts       stable tab ids, popups, navigation, viewport
    InputManager.ts     the arbiter: ordering, coalescing, de-duplication
    StreamManager.ts    per-tab screencast, keyframes, backpressure
    CookieManager.ts    shared-profile inspection
    HealthMonitor.ts    liveness probe
    cdp.ts  keymap.ts  profile.ts
  test/                 unit + real-Chromium integration tests
apps/web/src            React client: viewport, tabs, toolbar, presence, admin
packages/protocol       zod schemas + inferred types + frame codec (shared)
bench/benchmark.ts      load and latency harness
```

## Operating it

`./orbit help` lists everything; it wraps only the fiddly parts (first-run setup,
health waiting, the admin login cookie, volume backups) and delegates the rest to
`docker compose` and `npm`.

```bash
./orbit up                 # build, start, wait for healthy, print URLs
./orbit status             # container state + health + live metrics
./orbit url                # the address to share
./orbit logs               # follow the JSON log
./orbit user alice admin   # create a user (prompts for the password)
./orbit users              # list them
./orbit kick <userId>      # disconnect someone and kill their sessions
./orbit restart            # restart Chromium, keeping the profile and logins
./orbit bench 10 5 30      # 10 users, 5 tabs, 30s
./orbit backup             # tar the data volume (brief stop so the profile flushes)
./orbit restore <file>     # replace the volume from a backup
./orbit down               # stop (add --wipe to delete all state)
./orbit kill               # stop the container + kill every stray dev/test process
./orbit kill --purge       # the whole project: container, volume, image, build output
```

`kill` is the one to reach for when something is stuck: it stops the container and
kills leftover dev servers, test browsers and benchmark runs. Every pattern it
matches is anchored to this repo's path or the tests' own temp profiles, so it
cannot touch your own browser or unrelated work.

Run the benchmark across the real network by pointing it at the LAN address:

```bash
BASE_URL=http://192.168.1.100:3000 ./orbit bench
```

## Development

```bash
npm install
npm run dev         # API on :3000, Vite on :5173 with proxying
npm run typecheck
npm test
npm run build
npm run benchmark
docker compose up --build
```

`npm run dev` needs Chromium or Chrome on the host (`CHROMIUM_PATH` if it is
somewhere unusual). Tests launch a real browser on an OS-assigned CDP port, so
they never collide with a running dev server.

## Tests

`npm test` runs 74 tests, including an integration suite against a real Chromium:

- **unit** - scrypt hashing and timing, session cookie signing and tampering,
  role/grant permission matrix, the key map (Enter, Backspace, arrows, Ctrl+A,
  punctuation, numpad), URL scheme blocking, frame codec round trip, mDNS packet
  encode/parse, stale profile-lock clearing, stream backpressure and pacing.
- **arbiter** - input never crosses tabs, three users on one tab are serialised in
  arrival order, duplicate `eventId` and replayed `clientSequence` are dropped,
  per-connection sequence spaces, coordinate clamping, IME/touch/wheel dispatch.
- **integration** (real Chromium, real screencast, local test pages, no Internet):
  unauthenticated upgrades refused; two tabs created with distinct stable ids;
  two users streaming different tabs with no cross-delivery; both typing and
  navigating simultaneously, verified by the *pages themselves* reporting what
  they received; a third user joining the same tab and interleaving keystrokes
  with no loss; a viewer's input refused server-side; per-tab grants enforced;
  popups adopted; a title rewritten by page JavaScript reported (the SPA path);
  cookies shared across the profile; one user disconnecting while
  another keeps working; reconnect restoring the previous tab; malformed and
  over-rate messages rejected; **`SIGKILL` on Chromium recovered with tab ids
  preserved and input working again**; graceful shutdown notifying clients.

`npm run test:e2e` additionally drives the UI in a real browser with Playwright
(two independent browser contexts standing in for two machines). It is opt-in
because Playwright downloads browser binaries:

```bash
npm i -D @playwright/test && npx playwright install chromium
docker compose up -d
ADMIN_PASSWORD=... npm run test:e2e
```

## Acceptance criteria

| | Verified by |
|---|---|
| 1. `docker compose up --build` | `docker compose ps` → healthy; `/api/health` → `running` |
| 2-3. Two machines open `http://SERVER_IP:3000` | server binds `0.0.0.0`; port published; see [deployment.md](docs/deployment.md#firewall) |
| 4. Create two tabs | integration: *distinct stable ids* |
| 5. A → tab 1, B → tab 2 | integration: *both get frames, no cross-delivery* |
| 6-7. Simultaneous navigation and typing | integration: *pages report exactly what each user typed* |
| 8. C joins tab 1, both interact | integration: *interleaved keystrokes, none lost* |
| 9. A disconnects, C continues | integration: *browser alive, C still streaming and typing* |
| 10. A reconnects, session restored | integration: *same session, previous tab, stream resumes* |
| 11. Kill the browser | integration: *`SIGKILL` → recovered, tab ids preserved, input works* |
| 12. LAN drops and returns | client reconnects with jittered backoff and re-subscribes |

## Limitations

Honest list, expanded in [security.md](docs/security.md#known-limitations) and
[performance.md](docs/performance.md#honest-limitations):

- **No audio.** Screencast is video only.
- **One shared cookie jar by design.** Anyone with control can act as whoever the
  browser is signed in as. Per-user isolation is a documented seam
  (`Target.createBrowserContext`), not an implemented feature.
- **Chromium's own sandbox is off** so the container can drop all capabilities;
  the container is the sandbox. Reversible with `CHROMIUM_SANDBOX=true` and
  `cap_add: [SYS_ADMIN]`.
- **One machine, one browser.** Redis/Postgres seams are documented but the
  single-process design is deliberate for a LAN appliance.
- **`.local` discovery needs host networking**; the IP always works.
- **Bandwidth over elegance**: ~4 Mbps per 720p viewer. Fine on a LAN, and the
  reason a per-tab WebRTC transport is the natural next step for Internet mode.
- Two people dragging the same element still fight over one mouse pointer - the
  cursor overlay makes that visible rather than mysterious.

## License

MIT
