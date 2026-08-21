# Architecture

## The shape of it

```
                      LAN (no cloud, no Internet required)
                                    │
      ┌──────────────┬──────────────┴───────────────┬──────────────┐
   Laptop A       Laptop B                       Phone C        Tablet D
      │              │                              │              │
      └──────────────┴──────── HTTP + WebSocket ────┴──────────────┘
                                    │
                          :3000  (0.0.0.0)
  ┌─────────────────────────────────┴──────────────────────────────────┐
  │  Node process (one container)                                      │
  │                                                                    │
  │   express ── REST: login, state, admin, files                      │
  │   ws ────── Hub: identity, presence, routing, permissions          │
  │      │                                                             │
  │      ├── InputManager   per-tab FIFO arbiter → ordered dispatch    │
  │      ├── StreamManager  per-tab screencast → binary frames out     │
  │      ├── TabManager     stable tab ids over volatile targets       │
  │      ├── CookieManager  shared-profile inspection                  │
  │      ├── HealthMonitor  liveness probe → restart with backoff      │
  │      └── BrowserManager owns the Chromium process                  │
  │                    │                                               │
  │                    │  CDP over ws://127.0.0.1  (loopback only)     │
  │                    ▼                                               │
  │            ┌───────────────────────────────────────────┐           │
  │            │ Chromium (headless=new, one profile)      │           │
  │            │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐     │           │
  │            │  │Tab 1 │ │Tab 2 │ │Tab 3 │ │Tab N │     │           │
  │            │  └──────┘ └──────┘ └──────┘ └──────┘     │           │
  │            └───────────────────────────────────────────┘           │
  │                                                                    │
  │   SQLite (users, sessions, tabs, grants, audit)  ──►  /data        │
  │   Chromium profile (cookies, localStorage, …)    ──►  /data        │
  └────────────────────────────────────────────────────────────────────┘
```

Three authorities, and nothing else gets an opinion:

- **Chromium** is authoritative for page state. Nothing is predicted or
  simulated client-side.
- **The server** is authoritative for users, permissions, tabs and input order.
- **The client** renders frames and sends intents. It never invents state: a tab
  does not appear in the UI until the server says `tab.created`.

## Request paths

**Interactive path** (every mouse move, keystroke, frame) - WebSocket only:

```
DOM event → coalesce to 1/frame → ws JSON → zod parse → authorize
          → arbiter queue → CDP Input.* → Chromium
Chromium repaint → Page.screencastFrame (base64 JPEG) → Buffer
          → binary ws frame → createImageBitmap → canvas
```

**Control path** (login, admin, file transfer) - REST, because it is
request/response, needs status codes, and benefits from being cacheable and
curl-able.

## Why one process owns Chromium

`BrowserManager` spawns Chromium as a child. That single decision buys three
things: a crash is a process `exit` event rather than a polled probe; CDP never
leaves loopback, so there is no network path to it at all; and no Docker socket
needs mounting into a web-facing service. See
[decisions.md](decisions.md#4-browser-lifecycle).

Four Chromium flags are load-bearing rather than cosmetic:

```
--disable-background-timer-throttling
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
--disable-features=CalculateNativeWinOcclusion
```

Without them Chromium throttles or stops compositing tabs that are not in the
foreground, and everyone except one user would watch a frozen stream. With them,
a background tab reports `visibilityState: "visible"`, runs
`requestAnimationFrame`, and streams - verified directly, not assumed.

`Emulation.setFocusEmulationEnabled` is applied per page for the same reason:
otherwise only the foreground tab believes it has focus, and carets stop blinking
and `:focus` styles die everywhere else - fatal when four people type in four
tabs at once.

`status: running` is published only after `TabManager` has rebuilt the tab
session on the new connection, not when the process comes up. Clients act on
that signal by re-subscribing, so announcing it early would race every one of
them into a dead viewport - which is precisely what happened until the ordering
was fixed. A subscribe that still lands mid-recovery is retried once server-side.

## Tab identity

A tab is `tab_<ULID>` for the life of the deployment. The Chromium `targetId`
behind it is disposable and changes across crash recovery. Everything
user-visible - subscriptions, permissions, presence, "reconnect me to my tab" -
keys off the application id, which is why recovery is invisible to clients.

Popups are not special-cased anywhere in the UI: `Target.setAutoAttach` means a
`window.open` or `target="_blank"` page arrives as an attach event, gets adopted,
and is broadcast as `tab.created` to everyone who may see it.

## The arbiter

```
User A mousemove ─┐
User B keydown   ─┼─► per-tab FIFO ─► single drain worker ─► CDP (one socket,
User C click     ─┘    (coalesced)      assigns sequence       ordered by send)
```

Ordering is preserved without awaiting each command: messages on one CDP socket
are processed by Chromium in send order, so input is posted fire-and-forget.
Awaiting each dispatch would add a full round trip per event to the interaction
path for no ordering benefit.

`docs/protocol.md` documents the event envelope; `InputManager` carries the
de-duplication and coalescing rules.

## Streaming and backpressure

One screencast per tab, started when the first subscriber arrives and stopped
when the last leaves - an unwatched tab costs nothing. Frame pacing is done by
*delaying the ack*: Chromium will not produce the next frame until the previous
one is acknowledged, so a late ack throttles capture at the source rather than
encoding at 60fps and discarding.

Per-client backpressure is a `bufferedAmount` check: a client whose socket is
backed up past `BACKPRESSURE_BYTES` is skipped for that frame and gets the next
one. For interactive video a dropped frame always beats a late frame, and every
JPEG is independently decodable so there is no keyframe to wait for.

Late joiners get an explicit keyframe (`Page.captureScreenshot`), because
screencast is repaint-driven and a quiet page would otherwise show them nothing.

## Data

| State | Where | Why |
|---|---|---|
| users, sessions, tab metadata, grants, audit | SQLite on `/data` | queries, constraints, revocation |
| cookies, localStorage, IndexedDB, history, cache | Chromium profile on `/data` | it *is* the shared browser state |
| presence, cursors, input queues, frames | memory | thousands of events/second; worthless after a restart |

Schema (`apps/server/src/db.ts`): `users`, `sessions`, `browser_instances`,
`tabs`, `tab_users`, `audit_events`.

## Permissions

Server-authoritative, evaluated per message:

```
role admin                     → admin on every tab
role viewer                    → view, always (a control grant cannot lift it)
role user + explicit grant     → that grant
role user + no grant           → DEFAULT_TAB_PERMISSION (control)
```

Hidden buttons are a courtesy; `canControlTab()` is the control. Covered by
`permissions.test.ts` and exercised end-to-end in `integration.test.ts`.

## Failure behaviour

| Failure | What happens |
|---|---|
| One client disconnects | Its sinks and cursors are removed. The browser and everyone else are untouched. The user shows as `reconnecting` for 30s. |
| Client network blip | Client reconnects with jittered backoff, re-authenticates from the cookie, restores its previous tab, resumes the stream. |
| Chromium crashes | `exit` event → exponential backoff restart → profile reloaded from the volume → tab ids reclaimed → `browser.status: running` broadcast → clients re-subscribe → streams resume. |
| Chromium wedges (alive, unresponsive) | `HealthMonitor` fails 3 consecutive `Browser.getVersion` probes → restart. |
| Chromium cannot start at all | Backoff to 60s, gives up after 8 attempts with status `crashed`, so it does not pin a CPU forever. |
| A page opens `alert()` | Dismissed automatically - a blocking dialog would freeze that tab's stream for every viewer. |
| Client too slow for the frame rate | Frames dropped for that client only. |
| Client floods messages | Token bucket per connection; `rate_limited` error, then socket close for a persistent offender. |
| SIGTERM | Stop accepting connections → notify clients → stop streams → `Browser.close` (flushes the profile) → close database. |

## Scaling past one machine

The single-process design is deliberate for a LAN appliance. The seams that would
change first, in order:

1. **Presence and pub/sub → Redis.** `Hub` owns connection state in two maps;
   they become Redis structures, and `broadcast()` becomes a channel publish.
2. **Sessions and users → PostgreSQL.** `db.ts` is the only module with SQL in
   it, and the surface is `exec`/`prepare`/`run`/`get`/`all`.
3. **Sticky routing.** A user's frames come from the process that owns their
   Chromium, so the load balancer must pin a session to a host (or a control
   plane must route by `browserId`).
4. **Per-user isolation.** `Target.createBrowserContext` gives a separate cookie
   jar per user; `TabManager.createTab` is where a `browserContextId` would be
   threaded through. The default stays shared, because shared state is the
   product.
