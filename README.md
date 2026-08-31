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

## Setup

**You need:** Docker with Compose v2. About 4 CPUs and 4 GB free for the
container (6 and 6 is comfortable). One machine on the network to run it on —
that machine does all the work; everyone else just needs a browser.

### 1. Start it

```bash
git clone https://github.com/THE-ASHUTOSH/Orbit.git
cd Orbit
./orbit up
```

Not a developer, or you would rather not build anything? Use the published
image instead — no source code, ~475 MB download:

```bash
curl -fsSL https://raw.githubusercontent.com/THE-ASHUTOSH/Orbit/main/docker-compose.hub.yml -o docker-compose.yml
# put SESSION_SECRET and ADMIN_PASSWORD in a .env next to it, then:
docker compose up -d
```

[docs/team-guide.md](docs/team-guide.md) walks through that path in full,
including sharing it beyond your network.

That is the whole setup. On the first run the script:

1. starts Docker if it is not already running,
2. writes a `.env` for you — a random `SESSION_SECRET`, an admin password you
   type in, and the settings this project actually runs on rather than a bare
   minimum,
3. builds the image (a few minutes once; later runs are seconds),
4. waits until the browser inside is genuinely healthy,
5. prints the two URLs — one for this machine, one for everyone else.

```
open on this machine:  http://127.0.0.1:3030
open on the LAN:       http://192.168.1.100:3030
```

### 2. Open it

Open the LAN address on any device on the same network — laptop, phone, tablet —
and sign in as `admin` with the password you typed. Everyone can use it at the
same time, each in their own tabs.

### 3. Add the people you are sharing with

```bash
./orbit user priya          # prompts for a password; role defaults to user
./orbit user sam viewer     # can watch, never type
./orbit users               # list everyone
```

Roles: `admin` manages everything, `user` browses and opens tabs, `viewer` only
watches. By default a tab belongs to whoever opened it — others can watch it and
ask for control from the toolbar.

### That is it

`./orbit status` shows health and live metrics, `./orbit down` stops it and keeps
all data, `./orbit up` brings it back.

### If something does not work

| Symptom | Fix |
|---|---|
| `docker: command not found` | install Docker Desktop (macOS/Windows) or Docker Engine (Linux), then re-run |
| The LAN URL does not open from another device | allow inbound TCP on port 3030 in the host firewall; both devices must be on the same network |
| Port 3030 is already taken | set `APP_PORT=3040` in `.env`, then `./orbit up` |
| Forgot the admin password | `./orbit user <name> admin` makes another admin; `ADMIN_PASSWORD` only seeds the very first one |
| Pages look soft on a retina screen | `DEVICE_SCALE_FACTOR=1.5` in `.env`, then `./orbit up` (see [Tuning](#tuning)) |
| Anything else | [docs/troubleshooting.md](docs/troubleshooting.md) — symptom, cause, fix |

### Doing it by hand instead

`./orbit` is convenience, never a requirement:

```bash
cp .env.example .env         # then set SESSION_SECRET and ADMIN_PASSWORD
docker compose up --build
```

`openssl rand -hex 32` generates a secret. `./orbit env --template` prints the
exact `.env` the script would write, if you would rather read it first. No
Internet is needed once the image is built.

---

## Commands

Everything runs through one script. `./orbit help` prints this list.

### Running it

| Command | What it does |
|---|---|
| `./orbit up` | start Docker if needed, write `.env` on first run, build, start, wait for healthy, print the LAN URL |
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
| `./orbit test` | full suite: 121 tests, including real-Chromium integration |
| `./orbit bench [users] [tabs] [secs]` | latency and throughput benchmark |
| `./orbit stress [users] [tabs]` | stress, races and abuse, with pass/fail invariants |
| `./orbit env [--template]` | show the `.env` in use (secrets hidden), or the one a fresh run would write |
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

**Tabs belong to whoever opened them.** Press `+`, or click a link that opens a
tab, and that tab is yours: you drive it, everyone else watches. They see whose it
is and get one button — *Ask <name> for control* — which puts a prompt in front of
you wherever you are looking, with **Give control** or **Keep it to myself**.
Granting takes effect immediately, no reload. Nobody else can close or rename
your tab either; control, once given, is permission to type, not to dispose of it.

Closing a tab puts you back on the one you came from, not on whichever tab is
first — which is what makes a redirect into a new tab feel like a detour rather
than a place you get stranded. The trail is per person, so nobody else's view
moves.

A tab that arrives with **nobody** attached to it — one an extension opened for
itself, or a redirect with no trail back — belongs to whoever was working at the
time, and if even that is unclear it belongs to everyone: it is followed, and it
can be closed by the person looking at it. Ownership restricts tabs that *have* an
owner, never tabs that have none.
Set `TAB_OWNERSHIP=false` for the older free-for-all, where any tab is anyone's
to drive.

**Simultaneous users, same tab.** Once control is shared there is no locking and
no turn-taking. A per-tab server-side arbiter gives one authoritative order,
coalesces mouse moves, and de-duplicates retries. Other people's cursors are
drawn with their names.

**A predictable picture.** One rule decides a tab's resolution - the configured
size, the viewer's shape, the limits and the screen it is drawn on - so the same
window always gets the same viewport, across new tabs and refreshes alike. It can
never exceed the virtual screen the window lives on either: asking for more is
what Chromium returns as a black frame, and zooming out or going full screen used
to ask for exactly that. Every stream restart also pushes one frame immediately,
so a page sitting still is never left blank.

**It tells you when it is working.** A spinner in the tab and a thin strip across
the top of the page while it loads - indeterminate, because Chromium reports
"loading" or "not loading" and never a percentage.

**Real input.** Mouse move/down/up/click/double-click/right-click/wheel/drag,
touch, full keyboard with modifiers and shortcuts, IME composition, and paste.
Enter submits, Backspace deletes, Ctrl+A selects — because key events carry
proper virtual key codes, not just characters.

**Shared, persistent state.** One Chromium profile on a Docker volume: cookies,
logins, localStorage, IndexedDB and history survive restarts, and a login in one
tab is a login in every tab. The exception is a **session cookie** - one a site
sets with no expiry, meaning "forget this when the browser closes" - which is why
a restart used to sign you out of anywhere you had not ticked "keep me signed
in". `PERSIST_SESSION_COOKIES=true` carries those across a restart too, encrypted
at rest with a key derived from `SESSION_SECRET`. Off by default, because it
deliberately overrides what the site asked for.

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

**Keyboard shortcuts.** Two kinds, and the difference matters.

*What the remote page gets:* everything you press that Orbit does not claim,
including `Ctrl/⌘+C`, `V`, `X`, `A`, `Z` and any hotkey an extension registers.
On a Mac, ⌘ travels as Ctrl — the browser being driven is the Linux one in the
container, where Meta is the Super key and means nothing. Copy runs as a real
editing command in the page and the text comes back to *your* clipboard; paste
sends *your* clipboard, never the container's.

*Orbit's own shortcuts:* on Alt/Option, deliberately. `Ctrl+T`, `Ctrl+W` and
`Ctrl+L` belong to the browser Orbit is displayed *in* and cannot be intercepted
from a page; mapping them would, at best, do nothing and, in `Ctrl+W`'s case,
close your own tab. They are matched by physical key, so Option+T is still "new
tab" on macOS, where it types "†".

On Windows and Linux the modifier is **Alt**; on a Mac it is **Option** (⌥) — the
same physical key, and Orbit's menus and on-screen hints name whichever one you
are actually using.

| Shortcut | Action |
| --- | --- |
| `Alt`/`⌥`+`T` | New tab |
| `Alt`/`⌥`+`Shift`+`T` | Reopen the tab you just closed |
| `Alt`/`⌥`+`W` | Close tab |
| `Alt`/`⌥`+`D` | Focus the address bar |
| `Alt`/`⌥`+`1`…`8` / `9` | Nth tab / last tab |
| `Alt`/`⌥`+`←` / `→` | Back / forward |
| `F5`, `Ctrl+R` | Reload |
| `Ctrl+±`, `Ctrl+0` | Zoom in/out, reset |
| `Alt`/`⌥`+`F` | Full screen |
| `Alt`/`⌥`+`K` | Capture the keyboard for this tab (see below) |

**Full screen** — `Alt+F` (`⌥F` on a Mac), or **⋮ → Full screen**. The page takes
the whole display; the tab bar, toolbar and status bar **stay** — hiding them
would take away the controls you went full screen to use. A dimmed *Leave full
screen* pill sits in the corner (the same chord and `Esc` work too). Not just a
CSS trick: what it reclaims is your own browser's tabs and toolbar, so the stage
grows, Orbit asks the server for a bigger stream, and the picture gets sharper
rather than scaled up.

**Keyboard capture** — `Alt+K` (`⌥K` on a Mac), or **⋮ → Capture keyboard**, for the chords your
own browser normally keeps: `⌘T`, `⌘W`, `⌘L`, `⌘1`…`⌘9`, `Escape`. While it is on,
those go to the shared browser instead: `⌘T` opens a tab *in Orbit*, `⌘W` closes
one there, and an extension bound to `⌘⇧H` finally gets its key.

Capture uses the **same full screen** as full-screen mode — one look, whichever
way you got there, controls and all — and hands both back together: switching
tabs, `Alt+K`, or leaving full screen ends it. It is **per tab**, not per session. `Alt+K` or the on-screen badge
releases it, and so does leaving fullscreen.

Two conditions come from the browser, not from Orbit:

- it needs **fullscreen** (that is what the Keyboard Lock API requires), which is
  why the toggle takes the whole screen;
- it needs a **secure context**, so full capture works on `http://127.0.0.1:3030`
  and behind TLS, but *not* over plain http on a LAN IP — `navigator.keyboard`
  simply does not exist there. Orbit says so when that happens and still claims
  every chord a page is allowed to claim (`⌘R`, `⌘S`, `⌘P`, `⌘F`, `⌘D`…).

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

Two different knobs change "how it looks", and they are easy to mix up:

- **`VIEWPORT_WIDTH/HEIGHT`** is the page's *size* in CSS pixels. Bigger fits
  more content and makes everything look smaller.
- **`DEVICE_SCALE_FACTOR`** is the page's *sharpness*: identical layout, drawn
  with more real pixels. 1 to 3, fractions allowed.

| Want | Change |
|---|---|
| Less bandwidth | `STREAM_QUALITY=80`, or a smaller `VIEWPORT_WIDTH/HEIGHT` |
| Bigger text | `VIEWPORT_WIDTH=1600 VIEWPORT_HEIGHT=900` (less content, larger) |
| More content on screen | `VIEWPORT_WIDTH=2560 VIEWPORT_HEIGHT=1440` (smaller text) |
| Sharper on a retina screen | `DEVICE_SCALE_FACTOR=1.5` (1.4–2.6× the bandwidth) |
| Less CPU | `MAX_FPS=30` |
| Smoother | `MAX_FPS=60` (also shortens the frame-pacing part of latency) |

`DEVICE_SCALE_FACTOR` above 1 only helps clients whose screens have the pixels to
show it — on an ordinary monitor it costs bandwidth and looks very slightly
softer, because the frame is scaled back down on arrival. It is one setting for
everyone and Chromium takes it at launch, so changing it restarts the browser.
The measurements are in [docs/performance.md](docs/performance.md#sharpness).

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
| **[team-guide.md](docs/team-guide.md)** | **start here if you just want to run it and share it** — setup, usage, ngrok, troubleshooting, plain-language settings |
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
| `DEVICE_SCALE_FACTOR` | `1` | sharpness: real pixels per CSS pixel, 1–3, fractions allowed |
| `PERSIST_SESSION_COOKIES` | `false` | `true` keeps logins across `./orbit restart` |
| `MAX_FPS` | `30` | CPU and bandwidth, linearly |
| `CHROMIUM_HEADLESS` | `false` | headed on Xvfb; websites treat headless as unusual |
| `DEVTOOLS_ENABLED` | `false` | admin DevTools — read the security doc first |
| `EXTENSIONS_ENABLED` | `true` | extension loading |
| `MAX_TABS` / `MAX_USERS` | `20` / `50` | resource ceilings |
| `DEFAULT_TAB_PERMISSION` | `control` | `view` makes control opt-in per tab |
| `TAB_OWNERSHIP` | `true` | a tab belongs to whoever opened it; others watch until granted control. `false` restores the shared free-for-all |
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

`./orbit test` runs **121 tests**, including an integration suite against a real
Chromium:

- **unit** — scrypt hashing and timing, session cookie signing and tampering, the
  role/grant/ownership permission matrix (the owner administers their tab, others
  watch, an explicit grant wins, an unowned tab stays shared), the key map (Enter, Backspace, arrows, Ctrl+A,
  punctuation, numpad), URL scheme blocking, home-page resolution, frame codec
  round trip, mDNS packet encode/parse, stale profile-lock clearing, colour
  assignment never repeating, stream backpressure, keyframes and the resize race
  (a viewer joining while the viewport resizes must keep getting frames), bookmark and
  history upserts (visits accumulate, an empty title never erases a known one,
  suggestions ranked by visits then recency, `%` matched literally), extension id
  derivation, `.crx` unwrapping (CRX2, CRX3, a truncated header refused), the
  editing commands `Ctrl+C/V/X/A` need, the shortcut map against the key values a
  Mac actually produces (Option+T is `†`), and Chromium's argv — no switch passed
  twice, since a duplicate `--disable-features` silently discards the first list.
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
  a tab owned by a plain user refusing someone else's input, that person asking,
  the owner refusing and then granting, and control arriving without a
  re-subscribe (plus: control is not permission to close the tab);
  a right-click probe finding the real anchor under the pointer (and nothing in
  empty space); a paste arriving in the page's focused field; Ctrl+A/C/V/X really
  selecting, copying, pasting and cutting in the page;
  one user disconnecting while another keeps working; reconnect restoring the
  previous tab; malformed and over-rate messages rejected; **`SIGKILL` on
  Chromium recovered with tab ids preserved and input working again**; graceful
  shutdown notifying clients; and login throttling that counts failures rather
  than the people signing in.

`./orbit stress` is the harness that answers a different question: not "how fast
is it" but "what happens when it is pushed, raced, or broken". Nine scenarios,
each reporting measured numbers **and** pass/fail invariants - normal load, heavy
load, an escalating ladder to the declared limits, six people typing into one tab
at once (verified through the page itself, keystroke by keystroke), ownership
under contention, four deliberate races, limit and abuse handling, a two-minute
soak, and a `SIGKILL` of Chromium mid-stream. Results are written to
`bench/bench-results/stress-*.json`. See
[performance.md](docs/performance.md#stress-and-abuse) for the measurements.

`npm run test:e2e` additionally drives the UI in a real browser with Playwright
(two independent contexts standing in for two machines): sign-in, streaming and
live pixels, tab create/switch/close, bookmarking a page and finding it in the
panel, address-bar suggestions from history, the right-click menu,
`Alt+T`/`Alt+W`, a copy-and-paste round trip through the accelerator key, the
per-tab keyboard capture toggle, the full-screen round trip, and the ownership flow end to end between two
ordinary users. It is opt-in because Playwright downloads browser binaries:

```bash
npm i -D @playwright/test && npx playwright install chromium
ADMIN_PASSWORD=... npm run test:e2e
```

Only *failed* logins are rate-limited (10 a minute per IP), so repeated runs are
fine; the suite still signs in once and reuses the session, which is why a full
run takes seconds.

Both suites launch real browsers, so the assertions that wait on *pixels* are
timing-sensitive: under load - or while Chromium is still coming up after a
restart - "no frame within 30s" can fail for reasons unrelated to the code.
Re-run before believing it, and use `ITEST_LOG=debug npm test` when it repeats.

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
