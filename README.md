# Orbit

One real Chromium, shared over your LAN, where several people work in **different
tabs at the same time** — or in the same tab together, with each other's cursors
visible.

Not a remote desktop and not a screenshot poller. Orbit understands *tabs*: each
tab is streamed independently straight out of Chromium, so four people can be on
four different pages of one browser session, sharing one cookie jar, one set of
logins, one profile.

```
                          LOCAL NETWORK
   Laptop A          Laptop B          Phone C          Tablet D
      │                 │                 │                │
      └─────────────────┴──── :3030 ──────┴────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │  auth · presence   │
                    │  tabs · input      │
                    │  arbiter · streams │
                    └─────────┬──────────┘
                       private CDP (loopback only)
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

---

## Quick start

```bash
./orbit up
```

First run writes `.env` with a random `SESSION_SECRET` and an admin password you
type, builds the image, waits for the browser to be healthy, and prints the URL
to share. Open it from any device on the network and sign in.

Prefer doing it by hand? `cp .env.example .env`, set `SESSION_SECRET`
(`openssl rand -hex 32`) and `ADMIN_PASSWORD`, then `docker compose up --build`.
`./orbit` is a convenience wrapper, never a requirement.

**Requirements:** Docker with Compose v2, ~4 CPUs and 4 GB for the container (6/6
is comfortable), one open inbound TCP port. No Internet connection is needed once
the image is built.

---

## Commands

Everything runs through one script. `./orbit help` prints this list.

### Running it

| Command | What it does |
|---|---|
| `./orbit up` | build, start, wait for healthy, print the LAN URL |
| `./orbit status` | container state, health, live metrics, URLs |
| `./orbit url` | just the addresses to share |
| `./orbit logs [lines]` | follow the structured JSON log |
| `./orbit restart` | restart Chromium, keeping the profile and everyone's logins |
| `./orbit down` | stop, keep all data |
| `./orbit down --wipe` | stop and delete all data (asks you to type `WIPE`) |
| `./orbit kill` | stop, plus kill stray dev/test/benchmark processes |
| `./orbit kill --purge` | the whole footprint: container, volume, image, build output |

### People

| Command | What it does |
|---|---|
| `./orbit user <name> [role]` | create a user; prompts for the password (`admin`/`user`/`viewer`) |
| `./orbit users` | list users and their ids |
| `./orbit kick <userId>` | disconnect someone and invalidate their sessions |

### Extensions

| Command | What it does |
|---|---|
| `./orbit ext ls` | list installed extensions |
| `./orbit ext store <url\|id>` | install from the Chrome Web Store |
| `./orbit ext add <folder\|zip>` | install an unpacked extension (zips a folder for you) |
| `./orbit ext rm <id>` | uninstall one |

Chromium reads extensions only at launch, so follow any change with
`./orbit restart`.

```bash
./orbit ext store https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh
./orbit restart
```

Same thing from the app: **⋮ → Extensions**, paste the store URL, Install. That
panel is also where anyone opens an extension's popup or options page.

### Development and testing

| Command | What it does |
|---|---|
| `./orbit test` | full suite: 76 tests, including real-Chromium integration |
| `./orbit bench [users] [tabs] [secs]` | latency and throughput benchmark |
| `./orbit dev` | run from source without Docker (API `:3030`, Vite `:5173`) |
| `npm run typecheck` | TypeScript across every workspace |
| `npm run build` | build protocol, server and web |
| `npm run test:e2e` | Playwright UI tests (opt-in, see below) |

Include real network transit in the benchmark by pointing it at the LAN address
from **another machine**:

```bash
BASE_URL=http://192.168.1.100:3030 ./orbit bench 10 5 30
```

### Backup

| Command | What it does |
|---|---|
| `./orbit backup [file]` | tar the data volume (stops the browser briefly so the profile flushes) |
| `./orbit restore <file>` | replace the data volume from a backup |

### Raw equivalents

```bash
docker compose up -d --build      # start
docker compose ps                 # health
docker compose logs -f app        # logs
docker compose down               # stop, keep data
docker compose down -v            # stop, delete data
curl -s localhost:3030/api/health # liveness, no auth needed
```

---

## What it does

**Tabs.** Create, close, switch, navigate, reload, back/forward, duplicate,
rename, with live URL, title and loading state. Popups and `target="_blank"` are
adopted automatically and appear for everyone. Every tab has a stable id
(`tab_01M0…`), never an array index, and keeps it across a browser crash.

**Simultaneous users, different tabs.** Input is routed by user + tab + session.
Nothing crosses tabs — there is a test that proves it.

**Simultaneous users, same tab.** No locking, no turn-taking. A per-tab
server-side arbiter gives one authoritative order, coalesces mouse moves, and
de-duplicates retries. Other people's cursors are drawn with their names.

**Real input.** Mouse move/down/up/click/double-click/right-click/wheel/drag,
touch, full keyboard with modifiers and shortcuts, IME composition, and paste.
Enter submits, Backspace deletes, Ctrl+A selects — because key events carry
proper virtual key codes, not just characters.

**Shared, persistent state.** One Chromium profile on a Docker volume: cookies,
logins, localStorage, IndexedDB and history survive restarts, and a login in one
tab is a login in every tab.

**Presence.** Every person gets a distinct colour — assigned by position, not by
hashing, so no two people ever share a dot. The bar shows who is online and
**which page each of them is on**; the tab bar shows who is on each tab.

**Bookmarks and history, shared.** A star in the toolbar, a bookmarks panel, and
a history panel with search. The address bar suggests from both, ranked by visit
count then recency. Shared like everything else here: a link one person saves is
a link everyone has. History records what people actually navigated to (not
redirects mid-load), and only an admin can clear it.

**Its own right-click menu.** Chromium's context menu is a native popup outside
any page's compositor surface, so it can never appear in a stream. Orbit asks the
server what is under the pointer and builds the menu from the answer: open a link
or image in a new tab, copy a link or image address, back/forward/reload, copy,
paste, select all.

**Keyboard shortcuts** — on Alt/Option, deliberately. `Ctrl+T`, `Ctrl+W` and
`Ctrl+L` belong to the browser Orbit is displayed *in* and cannot be intercepted
from a page; mapping them would, at best, do nothing and, in `Ctrl+W`'s case,
close your own tab.

| Shortcut | Action |
| --- | --- |
| `Alt+T` | New tab |
| `Alt+Shift+T` | Reopen the tab you just closed |
| `Alt+W` | Close tab |
| `Alt+D` | Focus the address bar |
| `Alt+1`…`Alt+8` / `Alt+9` | Nth tab / last tab |
| `Alt+←` / `Alt+→` | Back / forward |
| `F5`, `Ctrl+R` | Reload |
| `Ctrl+±`, `Ctrl+0` | Zoom in/out, reset |

**Extensions.** An extensions panel in the ⋮ menu lists what is installed and
opens an extension's popup or options page. Admins install by pasting a **Chrome
Web Store** URL or id — Orbit fetches the `.crx` from Google's update service,
unwraps it and unpacks it — or by uploading a `.zip` (`./orbit ext add`) for
anything not on the store. Extension pages open as tabs, because an extension
popup is a native window that a screencast cannot see. Nothing is
signature-verified: an extension runs in the shared browser with the permissions
its manifest asks for, so installs are admin-only, audited, and the panel lists
those permissions.

**Downloads to your own machine.** Files the shared browser downloads are listed
in the app with a Save button that streams them to the device you are sitting at.
The remote browser has no access to your filesystem — this is the bridge.

**DevTools.** Real Chrome DevTools for any tab — Elements, Console, Network,
Sources — proxied through Orbit's authentication. Admin-only, page-scoped,
audited, and **off by default** (`DEVTOOLS_ENABLED`).

**Light and dark.** Follows your OS by default; a toggle in the bar cycles
system → light → dark and remembers the choice.

**Reconnection and crash recovery.** Heartbeats, online/idle/reconnecting states,
jittered-backoff reconnect that restores your session and previous tab. One
client leaving never disturbs the browser or anyone else. If Chromium dies it is
restarted with exponential backoff and tabs come back with their ids intact; if a
page's renderer dies it is detected, reloaded and reported.

**Auth and authorization.** Username/password with `scrypt`, server-side
sessions, `HttpOnly` signed cookies, authenticated WebSocket upgrades, and
`admin`/`user`/`viewer` roles plus per-tab `view`/`control`/`admin` grants —
enforced server-side, not by hiding buttons.

---

## Performance

Measured with `./orbit bench` against the running deployment. Nothing here is
estimated.

**Reference machine:** Apple M5 Pro (15 cores, 24 GB), Docker container limited
to **6 CPUs / 6 GB**, headed Chromium on Xvfb, 1920×1080 at JPEG quality 95, 45
fps cap, measured over **loopback** (a real LAN adds its own RTT).

| Load | FPS/client | Bandwidth | Input p50/p95 | **Interaction p50/p95** | CPU | Memory |
|---|---|---|---|---|---|---|
| 1 viewer, 1 tab | 30.3 | 8.6 Mbps | — | **21 / 45 ms** | 13% | 1.4 GB |
| 10 users, 5 tabs | 31.7 | 90 Mbps | 1 / 2 ms | **30 / 57 ms** | 37% | 1.6 GB |

"Interaction" is what you actually feel: from sending an input event to painting
the first frame that can contain its result, measured on one clock. Full
methodology, the headed-vs-headless comparison and the tuning knobs are in
[docs/performance.md](docs/performance.md).

Cost is **per streaming tab, not per viewer** — a frame is encoded once and
fanned out, so four people watching one tab costs about the same as one.

### Tuning

| Want | Change |
|---|---|
| Less bandwidth | `STREAM_QUALITY=80`, or a smaller `VIEWPORT_WIDTH/HEIGHT` |
| Bigger text | `VIEWPORT_WIDTH=1600 VIEWPORT_HEIGHT=900` (less content, larger) |
| Sharper | `VIEWPORT_WIDTH=2560 VIEWPORT_HEIGHT=1440` (more content, smaller) |
| Less CPU | `MAX_FPS=30` |
| Smoother | `MAX_FPS=60` (also shortens the frame-pacing part of latency) |

Then `./orbit up`. JPEG quality is close to free — 85→95 cost 27% bandwidth and
no measurable latency.

---

## How it works

Chromium is a child of the server process, driven over the DevTools Protocol on
**loopback only** — port 9222 is never published and never on a Docker network.

Frames come from `Page.startScreencast` **per page target**, which is what makes
per-tab collaboration possible at all: a desktop-capture + WebRTC design gives
you one opaque screen, and handing each user a different tab would mean
reimplementing a window manager. Frames are relayed as binary WebSocket messages
and painted to a canvas via `createImageBitmap`. Pacing is done by delaying the
frame ack, so Chromium throttles itself at the source instead of encoding frames
nobody will see. A client that falls behind loses frames rather than
accumulating stale ones.

Input goes the other way through a per-tab FIFO arbiter, so "two people typing at
once" means both are accepted concurrently and the server picks one order.

Full reasoning, including the options rejected and what each choice costs:
[docs/decisions.md](docs/decisions.md).

---

## Documentation

| | |
|---|---|
| [architecture.md](docs/architecture.md) | components, data flow, failure behaviour, scale-out seams |
| [decisions.md](docs/decisions.md) | ADRs: streaming, input, sync, lifecycle, discovery, auth, persistence |
| [protocol.md](docs/protocol.md) | every message, the input envelope, the binary frame format |
| [performance.md](docs/performance.md) | how latency is measured, results, tuning |
| [security.md](docs/security.md) | threat model, CDP containment, DevTools, hardening, limits |
| [deployment.md](docs/deployment.md) | LAN setup per OS, firewall, volumes, backup, Internet mode |
| [troubleshooting.md](docs/troubleshooting.md) | symptom → cause → fix |

---

## Configuration

Everything is environment variables; `.env.example` documents each one. The ones
that matter most:

| Variable | Default | Why you would change it |
|---|---|---|
| `SESSION_SECRET` | *(required)* | signs session cookies; changing it logs everyone out |
| `ADMIN_PASSWORD` | *(required)* | bootstrap admin — **first start only**, on an empty database |
| `APP_PORT` | `3030` | published port |
| `HOME_URL` | `about:blank` | page new tabs open on |
| `VIEWPORT_WIDTH` / `_HEIGHT` | `1280×720` | pixels streamed per tab |
| `PIN_VIEWPORT` | `false` | `true` ignores client window size and always streams the above |
| `STREAM_QUALITY` | `70` | JPEG quality 1–100 |
| `MAX_FPS` | `30` | CPU and bandwidth, linearly |
| `CHROMIUM_HEADLESS` | `false` | headed on Xvfb; websites treat headless as unusual |
| `DEVTOOLS_ENABLED` | `false` | admin DevTools — read the security doc first |
| `EXTENSIONS_ENABLED` | `true` | extension loading |
| `MAX_TABS` / `MAX_USERS` | `20` / `50` | resource ceilings |
| `DEFAULT_TAB_PERMISSION` | `control` | `view` makes control opt-in per tab |
| `MEMORY_LIMIT` / `CPU_LIMIT` | `4g` / `4.0` | container ceilings |

`ADMIN_PASSWORD` seeds the admin **only when the user table is empty**, so an env
var can never silently reset a live deployment's credentials. Change it later and
the stored password is unaffected — sign in with the old one, or start fresh with
`./orbit kill --purge`.

---

## Project layout

```
apps/server/src
  index.ts              bootstrap, static frontend, upgrade dispatch, shutdown
  runtime.ts            composition root; file chooser, downloads, page hooks
  config.ts  log.ts  db.ts  metrics.ts  mdns.ts  ids.ts
  auth/                 password (scrypt), sessions, permissions
  api/                  REST routes, origin validation, DevTools proxy
  ws/hub.ts             connections, presence, routing, authorization
  browser/
    BrowserManager.ts   Chromium process: launch, health, restart, shutdown
    TabManager.ts       stable tab ids, popups, navigation, crash recovery
    InputManager.ts     the arbiter: ordering, coalescing, de-duplication
    StreamManager.ts    per-tab screencast, keyframes, backpressure
    CookieManager.ts    shared-profile inspection
    HealthMonitor.ts    liveness probe
    extensions.ts       unpacked extension discovery and loading
    cdp.ts  keymap.ts  profile.ts
  test/                 unit + real-Chromium integration tests
apps/web/src            React client: viewport, tabs, toolbar, presence,
                        downloads, admin, theming
packages/protocol       zod schemas + inferred types + frame codec (shared)
bench/benchmark.ts      load and latency harness
orbit                   the CLI above
```

About 9,000 lines of TypeScript and 1,800 lines of documentation.

---

## Tests

`./orbit test` runs **90 tests**, including an integration suite against a real
Chromium:

- **unit** — scrypt hashing and timing, session cookie signing and tampering, the
  role/grant permission matrix, the key map (Enter, Backspace, arrows, Ctrl+A,
  punctuation, numpad), URL scheme blocking, home-page resolution, frame codec
  round trip, mDNS packet encode/parse, stale profile-lock clearing, colour
  assignment never repeating, stream backpressure and keyframes, bookmark and
  history upserts (visits accumulate, an empty title never erases a known one,
  suggestions ranked by visits then recency, `%` matched literally), extension id
  derivation, and `.crx` unwrapping (CRX2, CRX3, a truncated header refused).
- **arbiter** — input never crosses tabs, three users on one tab are serialised in
  arrival order, duplicate `eventId` and replayed `clientSequence` are dropped,
  per-connection sequence spaces, coordinate clamping, IME/touch/wheel dispatch.
- **integration** (real Chromium, local test pages, no Internet) — unauthenticated
  upgrades refused; two tabs with distinct stable ids; two users streaming
  different tabs with no cross-delivery; both typing and navigating
  simultaneously, verified by *the pages themselves* reporting what they
  received; a third user joining the same tab and interleaving keystrokes with
  none lost; a viewer's input refused server-side; per-tab grants enforced;
  popups adopted; SPA title changes reported; cookies shared across the profile;
  a right-click probe finding the real anchor under the pointer (and nothing in
  empty space); a paste arriving in the page's focused field;
  one user disconnecting while another keeps working; reconnect restoring the
  previous tab; malformed and over-rate messages rejected; **`SIGKILL` on
  Chromium recovered with tab ids preserved and input working again**; graceful
  shutdown notifying clients.

`npm run test:e2e` additionally drives the UI in a real browser with Playwright
(two independent contexts standing in for two machines): sign-in, streaming and
live pixels, tab create/switch/close, bookmarking a page and finding it in the
panel, address-bar suggestions from history, the right-click menu, and
`Alt+T`/`Alt+W`. It is opt-in because Playwright downloads browser binaries:

```bash
npm i -D @playwright/test && npx playwright install chromium
ADMIN_PASSWORD=... npm run test:e2e
```

Logins are rate-limited to 10 a minute per IP, and one full run signs in nine
times - two runs inside the same minute will hit that limit, not a bug.

The integration suite launches a real browser, so it is timing-sensitive: under
heavy CPU load a frame-timing assertion can occasionally flake. Re-run with
`ITEST_LOG=debug npm test` to see why.

---

## Limitations

Honest list, expanded in [security.md](docs/security.md#known-limitations) and
[performance.md](docs/performance.md#honest-limitations):

- **No audio.** Screencast is video only.
- **One shared cookie jar by design.** Anyone with control can act as whoever the
  browser is signed in as. Per-user isolation is a documented seam
  (`Target.createBrowserContext`), not an implemented feature.
- **Sharpness is bounded by the viewport.** More pixels means smaller content:
  `deviceScaleFactor` does not raise the stream's resolution (CDP screencast
  captures at the CSS viewport in DIP — measured), and CSS page zoom breaks input
  hit-testing. Genuinely "same text size, more pixels" needs a video-codec
  transport.
- **Chromium's own sandbox is off** so the container can drop all capabilities;
  the container is the sandbox. Reversible with `CHROMIUM_SANDBOX=true` and
  `cap_add: [SYS_ADMIN]`.
- **One machine, one browser.** Redis/Postgres seams are documented but the
  single-process design is deliberate for a LAN appliance.
- **`.local` discovery needs host networking**; the IP always works.
- **No Web Store one-click** for extensions — zip or folder only.
- **Bandwidth over elegance:** ~9 Mbps per 1080p viewer. Fine on a LAN, and the
  reason a per-tab WebRTC transport is the natural next step for Internet mode.
- Two people dragging the same element still fight over one mouse pointer — the
  cursor overlay makes that visible rather than mysterious.

---

## License

MIT
