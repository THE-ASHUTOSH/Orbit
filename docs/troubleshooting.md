# Troubleshooting

Start here, in this order:

```bash
docker compose ps                        # is it up, is it healthy
curl -s localhost:3000/api/health        # what does it think its status is
docker compose logs --tail=100 app       # what went wrong, in JSON
```

`/api/health` needs no authentication and reports `status`
(`starting`/`running`/`restarting`/`crashed`/`stopped`), the tab count and CDP
latency.

---

## Cannot reach the app from another machine

Work outwards:

1. **On the server**: `curl -s localhost:3000/api/health`. If this fails the app
   is the problem, not the network - see the next section.
2. **Right address?** `docker compose logs app | grep listening`. Use an address
   on the client's subnet.
3. **Reachable at all?** From the client: `ping <server-ip>`. If ping fails it is
   the network or Wi-Fi client isolation, not this app.
4. **Port open?** From the client: `curl -v http://<server-ip>:3000/api/health`.
   A hang means a firewall; connection refused means nothing is listening on
   that interface.
5. **Firewall / isolation**: see [deployment.md](deployment.md#firewall). Guest
   and hotel Wi-Fi routinely block device-to-device traffic outright.

`SERVER_HOST` must stay `0.0.0.0`; `127.0.0.1` would accept only local
connections. That is the default and Compose sets it explicitly.

## `http://shared-browser.local` does not resolve

Expected under Docker's default bridge network - multicast does not cross it. Use
the IP, or switch to `network_mode: host` on Linux and set `MDNS_ENABLED=true`
(see [deployment.md](deployment.md#platform-notes)). Windows needs Bonjour
installed to resolve `.local` at all. The IP address always works; discovery is a
convenience.

## Container starts, browser does not

`{"status":"restarting"}` or `crashed` from `/api/health`.

```bash
docker compose logs app | grep -E "chromium|profile lock"
```

| Log line | Meaning | Fix |
|---|---|---|
| `chromium exited unexpectedly ... code=21` | stale profile lock | should self-heal - the locks are cleared on launch. If it persists: `docker compose down && docker volume rm orbit-data` (destroys browser state) |
| `removed stale chromium profile lock` | normal after an ungraceful stop | nothing to do |
| `cannot launch /usr/bin/chromium` | binary missing (custom image) | set `CHROMIUM_PATH` |
| `CDP endpoint not reachable` | Chromium died during startup | check memory limits; give Docker ≥4 GB |
| `giving up on chromium restarts` | 8 consecutive failures | fix the underlying cause, then `docker compose restart app` |

Out-of-memory is the usual culprit on a small host: `docker stats`, and raise
`MEMORY_LIMIT` or lower `MAX_TABS`.

## Blank viewport / "Waiting for the first frame…"

1. **Is the page actually blank?** A brand-new tab is `about:blank`. Navigate
   somewhere.
2. **Is the stream running?** Admin panel → the tab should list ≥1 viewer, and
   metrics should show non-zero fps while the page changes.
3. **Test the pipeline in isolation**: navigate a tab to `/selftest`. That page
   repaints continuously; if it animates, streaming works and the original page
   was simply static (frames are repaint-driven - an idle page costs no
   bandwidth, by design). If `/selftest` shows a clock that never advances, the
   page's JavaScript is not running; if it shows nothing at all, frames are not
   arriving.
4. **Console errors** in *your* browser: a failed `createImageBitmap` means
   truncated frames, usually a proxy buffering the WebSocket
   (`proxy_buffering off`).

## Input does nothing

- **`VIEW ONLY` badge in the corner**: you have `view` permission. A `viewer`
  role can never send input; a `user` may have a view-only grant on that tab. An
  admin can change it (admin panel, or `PUT /api/tabs/:tabId/grants/:userId`).
- **Nothing happens and no badge**: click inside the viewport once - keyboard
  events need the surface focused.
- **Clicks land in the wrong place**: the frame is scaled to fit; coordinates are
  mapped from the canvas rect. A browser zoom other than 100% on the *client* is
  handled, but a stale frame after a resize can look offset for a moment.
- **Shortcuts open your own browser's menus**: `F12` and `Ctrl+Shift+I/J/C` are
  deliberately kept local. Everything else is forwarded.

## Typing is laggy

Open **metrics** in the status bar:

| Reading | Meaning |
|---|---|
| high `rtt` | network - Wi-Fi, distance, congestion |
| high `in` | server is loaded, or the client's uplink is saturated |
| high `q` | the arbiter is queueing: too much input for the page to keep up |
| high `total`, low others | Chromium repaint time - the page itself is slow |

Then: lower `MAX_FPS` or `STREAM_QUALITY` (bandwidth/CPU), reduce
`VIEWPORT_WIDTH/HEIGHT`, or unsubscribe from tabs nobody is watching. See
[performance.md](performance.md#tuning).

## Reconnect loops / "session expired"

- `SESSION_SECRET` changed → every cookie is invalid. Sign in again.
- `SESSION_TTL_HOURS` elapsed. Sign in again.
- The client retries with jittered backoff and checks `/api/auth/me` before each
  attempt, so a redirect to the login screen means the session is genuinely gone,
  not a network blip.
- Behind a proxy: `proxy_read_timeout` must exceed the heartbeat interval (15s),
  or the proxy will cut idle sockets. 3600s is a safe value.

## Ghost users in the presence list

A user shows as `reconnecting` for 30s after their socket drops, then disappears.
Heartbeat timeout is 45s, so a hard-crashed client can linger up to that long. If
someone is stuck longer than that, an admin can disconnect them (which also
deletes their sessions).

## Downloads and uploads

- Downloads land in `/data/downloads` and are listed at `GET /api/downloads`.
  `DOWNLOADS_ENABLED` must be on.
- A page's file dialog appears as a prompt in the app: your pick is uploaded to
  `/data/uploads` first, then attached to the page's input. `UPLOADS_ENABLED`
  must be on, and `MAX_UPLOAD_MB` caps the size.
- The container never sees your local filesystem - that is why the upload step
  exists.

## Clipboard does not sync

Needs `CLIPBOARD_ENABLED=1`, **control** permission on the tab, and a browser
that grants clipboard write access (Safari and Firefox are stricter than
Chromium, and some browsers require a user gesture). Paste into the viewport
always works: it is sent as text and inserted server-side.

## A page shows a dialog and freezes

`alert()`, `confirm()` and `prompt()` block the renderer, which would freeze the
tab's stream for every viewer, so they are dismissed automatically and logged.
Pages that depend on `confirm()` will behave as if the user cancelled.

## Tests or benchmark fail locally

```bash
npm install && npm run build && npm test
```

- Tests need Chromium or Chrome on the *host* (`CHROMIUM_PATH` if unusual). The
  integration suite launches a real browser on an OS-assigned CDP port, so it
  cannot collide with a running dev server.
- Stray browsers from an interrupted run: `pkill -f orbit-itest`.
- `npm run benchmark` needs a running server and valid credentials
  (`BENCH_PASSWORD`), and defaults to the server's own `/selftest` page so it
  works offline.
- Verbose integration logs: `ITEST_LOG=debug npm test`.

## Something is stuck - kill it all

```bash
./orbit kill              # stop the container, kill stray dev/test/bench processes
./orbit kill --purge      # also delete the volume, the image and build output
```

`kill` only signals processes matched against this repo's path or the tests'
`orbit-itest-` temp profiles, so it will not touch your own browser.

## Reset everything

```bash
./orbit kill --purge && ./orbit up    # or: docker compose down -v && docker compose up --build
```

The admin account is recreated from `.env` on the next start.

## "invalid_credentials" after editing .env

`ADMIN_PASSWORD` seeds the admin account **only when the user table is empty**,
so that an env var cannot silently reset a live deployment's credentials.
Changing it later does nothing to the stored hash. Either sign in with the old
password (and change it in the app), or start fresh with `./orbit kill --purge`.
