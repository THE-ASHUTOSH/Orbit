# Engineering decisions

Each record states the problem, what was considered, what was chosen, and what
the choice costs. Where a decision was settled by measurement, the measurement
is named; where it was settled by a hard requirement, that is said plainly
instead of dressing it up as a benchmark result.

---

## 1. Browser streaming transport

**Problem.** Deliver a live view of *individual browser tabs* to several people
on a LAN, with input-to-pixel latency low enough to feel like a local browser.

**Options considered.**

| Option | How it works | Verdict |
|---|---|---|
| **A. CDP `Page.startScreencast` → WebSocket** | Chromium encodes a JPEG per repaint, per page target; server relays binary frames | **Chosen** |
| B. Desktop capture (Xvfb/Wayland) → WebRTC | Capture the whole X/Wayland display, encode H.264/VP8/AV1, send over WebRTC | Rejected |
| C. `Page.captureScreenshot` polling over HTTP | Repeated screenshot requests | Rejected |
| D. Per-tab WebRTC video track | Screencast frames fed into an encoder, one `RTCPeerConnection` per tab | Deferred |

**Chosen: A.**

**Why.**

1. *It is scoped to a tab.* Screencast attaches to a page target. Four people on
   four tabs are four independent streams out of one Chromium. Option B produces
   one opaque desktop image: giving each user a different tab would mean
   arranging windows and cropping regions - reimplementing a window manager to
   recover information the browser already has. The requirement here is
   tab-level collaboration, not remote desktop, so B loses on architecture
   before latency is even discussed.
2. *No encoder pipeline.* Frames arrive already encoded. There is no capture
   loop, no colour conversion, no keyframe cadence to tune, and nothing to
   install: no Xvfb, no PulseAudio, no GStreamer, no `pion`/`aiortc`.
3. *Backpressure is built in.* Chromium will not produce the next frame until the
   previous one is acked. Frame pacing is therefore a matter of *when* the ack is
   sent - a one-line throttle that costs nothing, instead of capturing at 60fps
   and discarding.
4. *Latency is a JPEG decode, not a video pipeline.* No jitter buffer, no
   inter-frame dependencies, so no "wait for the next keyframe" hitch when a
   frame is dropped. Every frame is independently decodable, which is exactly
   what makes the drop-the-stale-frame policy safe.
5. *Measured, and good enough.* On the reference machine, input-to-visible-pixel
   is p50 21-31ms / p95 37-53ms across 5-20 concurrent users
   (see [performance.md](performance.md)) - inside the <100ms target and around
   the <50ms stretch goal. WebRTC's advantage is bandwidth efficiency and loss
   resilience on *bad* networks; on a LAN with 40-85 Mbps to spare, that
   advantage buys nothing that latency doesn't immediately pay for.

**Headless or headed?** Headless was chosen first, on the assumption that headed
Chromium only composites its focused window and would freeze background tabs.
Measurement disproved it once each tab got its own window, so the default is now
headed on Xvfb: bot-detection services treat headless as an unusual
configuration, and a browser for browsing real sites should look like a browser.
The price is measured (~40% CPU, 2x memory) rather than guessed - see
[performance.md](performance.md#headed-vs-headless). Note the direction of the
fix: making the environment genuinely normal, not spoofing signals to look normal.

**Tradeoffs accepted.**

- **Bandwidth.** ~3.7 Mbps per 720p/30fps viewer, versus roughly 1-2 Mbps for
  H.264 at similar quality. Fine on a LAN, and the reason Internet mode should
  revisit option D.
- **Repaint-driven, not clock-driven.** A page that does not change produces no
  frames. This is a feature (an idle tab costs nothing) with one sharp edge: a
  late joiner would see nothing on a static page, so `StreamManager` sends an
  explicit keyframe (`Page.captureScreenshot`) to each new subscriber.
- **No audio.** Screencast is video only. Audio would need a separate path
  (option B gets it for free).
- **Per-frame JPEG cost.** Full-frame encoding every repaint, with no motion
  compensation. Visible in the CPU numbers: ~5-6% of one CPU per streaming tab.

**When to revisit.** Internet mode, or more than ~20 concurrent viewers per host.
Option D is the natural next step and the architecture is ready for it:
`StreamManager` already owns per-tab subscriber sets and frame delivery, so a
WebRTC sink is a second implementation of `FrameSink`, not a rewrite.
`WEBRTC_ENABLED` / `STUN_SERVER` / `TURN_SERVER` are wired through config for it.

---

## 2. Input handling

**Problem.** Turn DOM events from many browsers into Chromium input, without one
user's typing appearing in another user's tab, and without a synthesised keypress
being subtly wrong.

**Options considered.**

- Send only characters (`Input.insertText`) - simple, and wrong: no shortcuts, no
  Enter, no Backspace, no arrows, no caret.
- Send raw DOM `KeyboardEvent` fields and hope Chromium infers behaviour.
- **Chosen:** translate to `Input.dispatchKeyEvent` with an explicit
  `windowsVirtualKeyCode`, and route composed text through `Input.insertText`.

**Why.** Chromium decides *editing behaviour* from the virtual key code, not from
`key`. Without it, Enter does not submit forms and Backspace does not delete;
with `text` set on a modified key, Ctrl+A both selects all *and* types "a". The
mapping is small, mechanical, and exactly the sort of thing that must be pinned
by tests - `keymap.test.ts` covers printable keys, shifted keys, editing keys,
shortcuts, punctuation-by-physical-code, and the numpad.

IME and paste are deliberately a separate path: `compositionend` and `paste`
produce one `input.text` message and one `Input.insertText` call, instead of
synthesising per-character key events for text the user never typed key by key.

**Tradeoffs.** A hand-maintained key table (a browser automation library would
provide one, at the cost of the abstraction rejected in decision 3). Dead keys
and multi-step IME candidate windows commit only on `compositionend`: the
candidate UI is local to the user's own browser, not rendered in the stream.

---

## 3. Multi-user synchronisation

**Problem.** "Several users control the same tab simultaneously", when a page
processes input strictly sequentially.

**Options considered.**

- **Locking / turn-taking.** One user holds control, others request it. Rejected:
  the requirement is explicitly that no manual locking is needed, and it makes
  two people filling one form miserable.
- **Optimistic local prediction with reconciliation** (CRDT-style). Rejected: we
  do not own the page's state. Chromium is the authority and there is nothing to
  merge - predicting a click's effect means predicting arbitrary JavaScript.
- **Chosen: a server-side arbiter.** Per-tab FIFO queue, single drain worker,
  arrival order at the server *is* the order Chromium sees.

**Why.** It gives one authoritative order with no user-visible ceremony: everyone
types whenever they like, and the server serialises. Two properties make it feel
good rather than merely correct:

- **mousemove coalescing per (tab, user).** A move still sitting in the queue is
  overwritten rather than appended, so a slow drain cannot build a backlog of
  stale cursor positions. Measured queue depth stayed at 0 even with 20 users.
- **De-duplication by `eventId` + per-connection `clientSequence`.** A client
  that retries after a reconnect cannot double-click or double-type.

**Tradeoffs.** Simultaneity is "concurrent submission, serialised execution" -
two users typing into the *same* text field interleave characters, because that
is what the DOM does. Two users dragging the same element fight over one mouse
pointer; the multi-user cursor overlay makes that visible so people naturally
avoid it. Ordering is by server arrival, so a user on a slower link loses ties -
deliberate, since the alternative (client timestamps) is forgeable and needs
clock sync.

---

## 4. Browser lifecycle

**Problem.** One shared Chromium must survive client churn, restart after a
crash, and never lose tab identity or profile data.

**Options considered.** A separate `browser` container driven over the Docker
socket (the server could then restart it), Chromium under a supervisor (s6,
supervisord) with the server as a client, or Chromium as a child of the server.

**Chosen:** Chromium is a child process of the server.

**Why.** The server is already the thing that must know when the browser died,
so making it the parent means the signal is a process `exit` event rather than a
polled health check plus a socket call to a daemon. It also means CDP never has
to leave loopback (see decision 6 in [security.md](security.md)) and there is no
Docker socket mounted anywhere, which would otherwise be a root-equivalent
capability handed to a web-facing service.

**How identity survives.** Application tab ids (`tab_<ULID>`) are stored in
SQLite and are *not* Chromium target ids. After a crash, `TabManager` reclaims
live page targets for their previous ids **before** enabling auto-attach - if it
did so after, Chromium's own attach event would arrive first and each page would
be adopted as a new tab with a new id, breaking "reconnect to your previous tab".
Tabs with no surviving page are recreated at their last URL, keeping their id.

**Tradeoffs.** A wedged renderer cannot be killed independently of the browser;
`HealthMonitor` restarts the whole browser instead. Restarts are backed off
exponentially (1s → 60s, then give up) so a profile that cannot start does not
become a hot restart loop. Two bugs found by actually restarting the container
are worth recording:

- A killed container leaves `SingletonLock` in the profile naming a hostname and
  pid that no longer exist. Chromium then refuses to start (exit 21) *forever*,
  because a container's hostname changes on every recreate. The locks are now
  cleared at launch - see `browser/profile.ts` and its test.
- The lock is a *dangling symlink*, so `existsSync` reports it absent. Detection
  has to use `lstat`. This is the kind of thing that only shows up if you restart
  the thing you built.

---

## 5. LAN discovery

**Problem.** Let people reach the app without being told an IP address.

**Options considered.** A published service record via a Bonjour library, a
hand-written mDNS responder, or nothing at all.

**Chosen:** a ~90-line mDNS responder that answers A queries for
`<MDNS_HOSTNAME>.local`, with the IP address as the always-available fallback.

**Why.** Advertising a *service* (`_http._tcp`) makes the app appear in service
browsers, which is not what people want - they want to type a name into the URL
bar. That needs an A record for the hostname, which the service-advertisement
libraries do not provide. One question type and one record type is less code than
integrating a dependency that solves the adjacent problem.

**Tradeoffs.** Multicast does not cross a Docker bridge network, so `.local` only
works with `network_mode: host` (Linux) or when running the server directly on
the host. It is off by default in Compose for that reason. Many corporate and
guest networks block multicast; every failure path here is non-fatal and the IP
address is unaffected. Also: nothing else on the network may claim the same
name - the responder sets the cache-flush bit but does not implement full
conflict resolution.

---

## 6. Authentication

**Problem.** Authenticate people on a LAN appliance, and authenticate the
WebSocket, without a cloud identity provider.

**Options considered.** A shared password for everyone (no per-user identity, so
no presence and no per-tab permissions), JWTs in `localStorage` (XSS-readable,
and revocation needs server state anyway), or server-side sessions in an
HttpOnly cookie.

**Chosen:** username + password with `scrypt`, server-side sessions, HMAC-signed
session id in an `HttpOnly; SameSite=Lax` cookie.

**Why.** Per-user identity is load-bearing for the rest of the product - presence,
cursors, per-tab grants and the audit trail all need to know who someone is.
`scrypt` is memory-hard **and in the Node standard library**, so the container
needs no native bcrypt/argon2 build. Sessions live in SQLite, so revocation
("disconnect this user") is a `DELETE`, not a token blocklist. The cookie is
signed so a forged or tampered value is rejected before any database lookup.

The WebSocket is authenticated from the same cookie at upgrade time and the
client's identity is taken from that session, never from the message payload -
`userId` is not a field a client can send.

**Tradeoffs.** No SSO, no MFA, no password reset flow (an admin resets passwords).
The seam for OAuth/OIDC is `sessionFromRequest()`: anything that can produce a
`UserRow` plugs in there without touching the hub or the routes.
`SameSite=Lax` rather than `Strict` so that following a link to the app keeps the
session, with Origin validation on every state-changing request and on the
WebSocket upgrade as the CSRF control.

---

## 7. Persistence

**Problem.** Users, sessions, tab metadata and permissions must survive restarts.
Browser state - cookies, logins, localStorage - must too. High-frequency events
must not touch a disk.

**Options considered.** PostgreSQL (a second container plus a client library and
migrations), a JSON file (no queries, no constraints, corrupt on a bad write),
or SQLite via the standard library.

**Chosen:** `node:sqlite` for application state, and the Chromium profile
directory on a Docker volume for browser state.

**Why.** Real tables, real constraints, real transactions, zero dependencies and
zero extra services - `node:sqlite` ships with Node 22.5+. A single-machine LAN
deployment has exactly one writer, which is the workload SQLite is best at. The
browser's own state is not modelled at all: it lives in one Chromium profile, so a
login in one tab is a login in every tab, exactly as in a desktop browser. That
is the whole point of a *shared* browser, and re-implementing it as
"cookie sync between contexts" would be strictly worse.

**What is deliberately not stored.** Mouse moves, key events, frames, cursor
positions and presence are in memory only. Auditing input events would mean
thousands of writes per second for no forensic value; the audit log records
logins, tab lifecycle, permission changes and admin actions.

**Tradeoffs.** One writer, one machine: horizontal scale-out needs Postgres plus
Redis pub/sub for presence, and `WAL` mode does not make SQLite safe over NFS.
The schema is small enough that the migration is mechanical (see
[architecture.md](architecture.md#scaling-past-one-machine)). `node:sqlite` is
still marked experimental in Node 24 - it emits a warning, the API has been
stable in practice, and the entire surface used is `exec`/`prepare`/`run`/`get`/
`all`, which is trivial to port to `better-sqlite3` if that changes.

---

## 8. Browser-shaped UI inside a browser tab

**Problem.** Orbit is displayed inside a real browser, and three things a normal
browser does are not available to a page: the keyboard shortcuts, the right-click
menu, and an extension's popup window.

**Options considered.** Map the familiar chords anyway and hope; render a fake
menu with no knowledge of the page; or accept the constraint and pick mechanisms
that actually work through a stream.

**Chosen:**

- **Shortcuts on Alt/Option.** `Ctrl+T`, `Ctrl+W`, `Ctrl+L`, `Ctrl+Tab` and
  `Ctrl+1…9` are reserved by the host browser and are not cancellable from a
  page. Mapping them would do nothing - except `Ctrl+W`, which would close the
  user's own tab. So Orbit uses `Alt+T/W/D`, `Alt+Shift+T`, `Alt+1…9` and
  `Alt+←/→`, which are cancellable, plus `F5`/`Ctrl+R` for reload and `Ctrl+±/0`
  for zoom (already intercepted for the remote viewport).
- **A server-answered context menu.** On right-click the client sends
  `context.probe` with the page coordinate; the server runs one
  `elementFromPoint` evaluation and replies with the link, image and selection
  under the pointer (`context.info`). The menu is then built from facts about the
  real page, not guesses. Chromium's own menu is a native popup outside the
  page's compositor surface - it can never appear in a screencast, no matter how
  the capture is done.
- **Extension pages as tabs.** An extension popup is likewise a native window.
  The page behind it is ordinary HTML at `chrome-extension://<id>/…`, so the
  extensions panel opens it as a tab. The id is derived the way Chromium derives
  it (SHA-256 of the manifest key, or of the load path for an unpacked
  extension, in the a-p alphabet), and the client only ever sends an extension
  id - the URL is built server-side, because `chrome-extension://` is otherwise
  a scheme no client may navigate to.

- **Accelerators travel as Ctrl, with an explicit editing command.** Two things
  are needed to make Ctrl/⌘+C actually copy. First, a Mac viewer's ⌘ has to
  arrive as Ctrl: the remote browser is Linux, where Meta is the Super key, so ⌘
  otherwise does nothing at all. Second, Chromium resolves editing accelerators
  in its *browser* process from real OS input and hands the renderer a command -
  so an injected key event needs CDP's `commands` field, or the page sees
  "Ctrl held, letter pressed" and nothing happens. Both are measured in the
  tests (`keymap.test.ts`, and a real copy/paste round trip in the integration
  and UI suites). Paste is the exception: it is deliberately *not* forwarded, so
  the viewer's own browser fires its `paste` event and the text comes from the
  clipboard the user actually copied into.

- **Keyboard capture, per tab, opt-in.** The chords the host browser reserves can
  be reclaimed after all, but only through the Keyboard Lock API, and only on its
  terms: fullscreen, a user gesture to enter it, and a secure context (so plain
  http on a LAN IP does not qualify - `navigator.keyboard` is absent there, which
  is measured, and the UI says so rather than pretending). Since capture takes
  both the screen and every chord, it is a toggle rather than a mode Orbit
  chooses for you, and it is scoped to one tab: switching tabs hands the keyboard
  back. The way out cannot be one of the host's chords, so it is `Alt+K` plus an
  on-screen badge. With it on, `⌘T` reaches the remote browser and opens a real
  tab there - which Orbit adopts, redirected from `chrome://newtab` to the same
  home page the "+" button uses.

- **One full screen, not two - and it keeps the controls.** Capture needs
  fullscreen (that is where the Keyboard Lock API applies) and full-screen mode
  wants it, so both produce the same thing: the whole display for the page, with
  the tab bar, toolbar and status bar still there. What full screen reclaims is
  the *host* browser's tabs and toolbar; hiding Orbit's own as well would remove
  the controls the mode exists to make room for. Which of the two took the screen is remembered, so
  releasing the keyboard only gives the screen back when capture is what claimed
  it - and every way out (the toggle, a tab switch, leaving fullscreen) goes
  through one routine, because when they were separate a tab switch released the
  lock and left the screen taken with nothing on screen to explain it.

- **Full screen shares one primitive with capture.** Both want the display, and
  fullscreen is a property of the document, not of a component - so there is a
  single `enterFullscreen`/`exitFullscreen` pair, and releasing the keyboard
  leaves the screen alone when full-screen mode is the one holding it. Leaving
  fullscreen by any route the browser owns (`Esc`, `F11`, the OS) ends both,
  which is why the state is reconciled from `fullscreenchange` rather than
  assumed from whoever asked.

**Tradeoffs.** The shortcuts are not the ones muscle memory expects, which is
why they are listed in the README and in the menu. Copy from the page uses the
selection the probe already reported rather than a synthetic `Ctrl+C`, and paste
depends on the *viewer's* browser granting clipboard read - a prompt Orbit cannot
answer for it. An extension that draws its popup as a native panel with no page
behind it has nothing to open, and the panel says so ("no page"). Extension *hotkeys* do work, both kinds: a
content script's own keydown listener sees forwarded keys, and a
`chrome.commands` shortcut fires too - Chromium hands an unhandled key event back
to the browser process, so its accelerators still run. Measured with a probe
extension, not assumed.

---

## 9. Installing extensions from the Chrome Web Store

**Problem.** Chromium only takes unpacked extensions at launch, but almost
everything a user wants is published on the Web Store, and asking an admin to
find a zip elsewhere is a poor answer.

**Options considered.** Zip upload only; drive the store UI inside the shared
browser (it refuses to install without the store's own flow, which needs a
signed-in Google profile and a browser restart to take effect anyway); or fetch
the `.crx` from the same update service every Chrome install talks to.

**Chosen:** fetch the `.crx` by id, strip the wrapper, unpack the zip that is
inside it - the same unpack path an uploaded zip takes.

**Why.** It makes the common case one paste, and it is the only route that gets
the actual published artefact without a Google account in the shared profile.

**What this is not.** The signature is not verified and there is no auto-update:
the trust boundary is the admin, exactly as with an uploaded zip. Installs are
admin-only, audited, and the panel lists every permission the manifest requests -
which matters, because an extension in the shared browser can see everyone's
sessions. The unpacked copy also gets a path-derived id rather than its store id
(the store id lives in the signed header we discard), so an extension that
hardcodes its own id - OAuth redirect URIs, mostly - can misbehave. Those are the
cases where the zip route, or not installing it at all, is the right call.

---

## 10. Who a tab belongs to

**Problem.** "Several people, one browser" was built so that anybody could drive
anything - which is right for two people looking at one screen together, and
wrong the moment someone is filling in a form, reading their mail, or typing a
password while a colleague's cursor is in the same tab. A shared browser needs a
notion of *whose tab this is*.

**Options considered.** A per-tab lock with a timeout (whoever touched it last
holds it, which turns into a race every time two people move at once); a
first-come "driver" role that has to be explicitly released (someone always
forgets, and then nobody can work); or ownership by the act of opening the tab,
with an explicit hand-over.

**Chosen:** the tab belongs to whoever opened it, and control is something they
give away.

- Opening a tab is the claim: the `+` button carries the requester, and a tab a
  page opened is attributed to whoever was last driving the tab that opened it -
  the same attribution that already decided whose view follows a new tab.
- The owner's effective permission on that tab is `admin`, not `control`, because
  handing control to someone else is a tab-admin act. Everyone else is `view`.
  An explicit grant still wins, so an admin can fix any situation.
- Closing and renaming go with ownership too. Refusing input while still letting
  a bystander close the tab would be a strange kind of protection.
- Asking is a message, not a side channel: `tab.access.request` reaches the
  owner's connections wherever they happen to be looking - and admins when the
  owner is offline, so a request is always answerable - and their
  `tab.access.respond` writes a real per-tab grant. A pending request is
  suppressed for 30 seconds, so a refusal cannot be turned into a stream of
  prompts.
- Granting takes effect immediately: the server pushes the new `tab.permissions`
  to that user, so nothing needs reloading or re-subscribing.

**Tradeoffs.** This is a change of default, so `TAB_OWNERSHIP=false` keeps the
old behaviour for groups who preferred it. Tabs that predate the feature - and
the browser's own first tab - have no owner and stay shared; there is a test for
that, because silently locking existing tabs to nobody would be worse than
leaving them open. And ownership is not privacy: everyone can still *see* every
tab, which is the point of a shared browser. Anyone who needs a page nobody else
can read needs their own browser, not a grant in this one.
