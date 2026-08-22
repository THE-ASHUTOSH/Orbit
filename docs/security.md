# Security

Threat model: **users may be untrusted, the LAN may be untrusted, and the pages
they browse are definitely untrusted.** The container is the isolation boundary
for the browser; authentication and authorization are the boundary for the API.

## The one that matters most: CDP is never exposed

Chromium's DevTools Protocol can read any cookie, execute arbitrary JavaScript in
any page, and read local files. Exposing it is equivalent to handing out a root
shell for the browser session.

```
client ──► authenticated REST/WebSocket ──► browser controller ──► CDP ──► Chromium
                                                            (127.0.0.1 only)
```

Structural, not merely configured:

- Chromium is launched with `--remote-debugging-address=127.0.0.1`.
- Chromium is a **child of the server process, in the same container**, so the
  only thing that can reach loopback is the server itself.
- Port 9222 is not published, not in `EXPOSE`, and not on any Docker network.
- No route or message type forwards a raw CDP command **except** the DevTools
  proxy described below, which is disabled by default.
- `CDP_PORT=0` is supported (OS-assigned port, discovered via the profile's
  `DevToolsActivePort`) so a fixed port cannot be squatted or guessed.

## DevTools (`DEVTOOLS_ENABLED`, off by default)

Chrome DevTools needs a real CDP channel, so this is the one feature that hands
one to a client. Be clear-eyed about what it grants: whoever opens it can run
arbitrary JavaScript in that page, read the page's cookies and storage, and see
every request it makes. In a *shared* browser that means access to whatever
accounts that page is signed into.

It is therefore constrained on four axes:

| | |
|---|---|
| **Disabled by default** | `DEVTOOLS_ENABLED=false`. With it off, both the frontend route and the socket return 403/404 - there is no path to reach it. |
| **Admins only** | Checked on the HTTP route *and* again on the WebSocket upgrade, before a byte reaches Chromium. A `user` with control of a tab gets 403. |
| **Page-scoped** | The proxy attaches to `/devtools/page/<targetId>`, never the browser endpoint. No `Target.*`, no `Browser.close`, no `Storage.getCookies` across every origin - one page only. The target id must belong to a tab this server tracks, so the parameter cannot be pointed elsewhere. |
| **Audited** | Every open writes `devtools.open` to `audit_events` with the user and tab, and logs at warn level. |

Chromium's debugging port still never leaves loopback: this server remains the
only thing that talks to it. What changed is that an authenticated admin can
borrow that channel for a single page, through an origin-checked, session-
authenticated socket.

The DevTools frontend is proxied from Chromium itself rather than vendored, so
it always matches the browser version. It is served with its own CSP (it needs
inline scripts and `eval`, which the application's own policy forbids) scoped to
this origin only - the app's CSP is not loosened.

**Recommendation:** leave it off unless you are debugging, and turn it off again
afterwards. It is a debugging tool, not an operating mode.

## Authentication

- **Passwords**: `scrypt` (N=32768, r=8, p=1, 64-byte key, 16-byte random salt),
  from Node's standard library. Format `scrypt$N$r$p$salt$hash`. Plaintext is
  never stored or logged.
- **Timing**: a login for a non-existent user still runs a full scrypt, so
  response time does not reveal whether an account exists. Comparison is
  `timingSafeEqual`.
- **Sessions**: server-side rows in SQLite. The cookie holds the session id plus
  an HMAC-SHA256 signature, so a forged or tampered cookie is rejected before any
  database lookup. `HttpOnly`, `SameSite=Lax`, `Secure` when `SECURE_COOKIES=1`.
  Sliding expiry refreshes at half the TTL; `SESSION_TTL_HOURS` bounds it.
- **Revocation**: deleting session rows. "Disconnect user" closes live sockets
  *and* deletes their sessions, so a reconnect cannot resume.
- **WebSocket**: authenticated at upgrade from the same cookie. No token in the
  URL - URLs end up in logs and proxy history.
- **Login throttling**: 10 attempts per IP per minute → HTTP 429.

Bootstrap: the admin account is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD`
**only when the user table is empty**, so an env var left in a shell history
cannot silently reset a live deployment's credentials.

## Authorization

Server-authoritative on every message and every route. The frontend hides
controls as a courtesy; it is never the check.

| Role | Can |
|---|---|
| `admin` | everything: tabs, users, grants, browser restart, cookie inspection, audit |
| `user` | view and control permitted tabs, create/close/rename tabs, see presence |
| `viewer` | view only - **input is refused server-side even if granted control** |

Per-tab grants (`view` / `control` / `admin`) override the default for a `user`;
a `viewer` is capped at `view` regardless, so a mistaken grant cannot turn one
into a controller. Verified in `permissions.test.ts` and end to end in
`integration.test.ts` ("a viewer can watch but its input is refused
server-side").

## Input validation

Every inbound message is parsed with the shared zod schema before anything else
looks at it: unknown types, bad tab-id shapes, out-of-range modifier bitmasks and
oversized payloads are rejected with `invalid_message`. Coordinates are clamped
to the tab viewport. `userId` is not a wire field - identity comes from the
session.

Navigation is restricted to `http(s)` plus `about:blank`. `file:`, `chrome:`,
`chrome-extension:`, `devtools:`, `view-source:` and `filesystem:` are refused
(`tabs.test.ts`), which keeps a remote user from pointing the shared browser at
the container filesystem or at Chromium's own settings.

## CSRF and origin

Browsers do not apply same-origin to WebSockets and do send cookies on
cross-site requests, so the server checks `Origin` itself:

- every state-changing REST request, and every WebSocket upgrade;
- allowed: same host, private-range/localhost/`.local` origins (this is a LAN
  product), plus anything in `TRUSTED_ORIGINS`;
- a missing `Origin` is allowed, because that means a non-browser client (curl,
  the benchmark) and CSRF requires a browser.

`SameSite=Lax` is the second layer.

## Response headers

`Content-Security-Policy` (`default-src 'self'`, no inline scripts, no external
origins), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, and HSTS when `SECURE_COOKIES=1`. The one CSP
exception is `/selftest`, which is served with `default-src 'none'` plus its own
inline script - it needs an animation loop and is allowed no network access
whatsoever.

## Files

- Uploads land only in `UPLOAD_DIR`; names are `basename`d and sanitised to
  `[A-Za-z0-9._-]`. `MAX_UPLOAD_MB` is enforced while streaming, not just from
  `Content-Length`.
- A page's file dialog can only be answered with files already in `UPLOAD_DIR` -
  it can never name an arbitrary container path.
- Downloads are confined to `DOWNLOAD_DIR` and served only to authenticated users,
  again via `basename` so `../` is inert.
- No host directory is mounted into the container. The only writable paths are
  the `browser-data` volume and two tmpfs mounts.

## Clipboard

Off unless `CLIPBOARD_ENABLED=1`. Page → client copies are delivered only to
users with **control** on that tab, never to viewers, and clipboard text is never
logged (the logger redacts `clipboard`, `text`, `token`, `password`, `cookie` and
friends by key name).

## Container hardening

From `docker-compose.yml`:

```yaml
security_opt: [no-new-privileges:true]
cap_drop: [ALL]
read_only: true
tmpfs: [/tmp, /home/browser]
init: true
deploy.resources.limits: { cpus: '4.0', memory: 4g }
```

Runs as uid 10001 (`browser`), never root. Root filesystem immutable; only the
data volume and two tmpfs mounts are writable. No Docker socket. Only port 3030
published.

**Chromium's own sandbox is disabled** (`--no-sandbox`), because the user
namespace it needs requires `SYS_ADMIN`, which would undo the capability
dropping above. The trade is deliberate: the *container* is the sandbox, and it
has no capabilities, an immutable filesystem, no host mounts and CPU/memory
caps. To run with Chromium's sandbox instead, set `CHROMIUM_SANDBOX=true` and
add `cap_add: [SYS_ADMIN]` - stronger in-browser isolation, weaker container
isolation. Note that a shared browser is a shared trust domain either way: one
user's tab can see another's cookies, exactly as tabs in a desktop browser do.

## Resource limits

`MAX_TABS` (20), `MAX_USERS` (50), `MAX_FPS` (30), `MAX_MESSAGE_RATE` (200/s per
connection), `MAX_UPLOAD_MB` (50), `BACKPRESSURE_BYTES` (256KB), plus the
container CPU/memory caps. Browser restarts are backed off exponentially and
abandoned after 8 failures, so a broken profile cannot become a restart loop.

## Logging

Structured JSON with `requestId`, `userId`, `tabId`, `browserId`, `sessionId`
where relevant. Passwords, hashes, tokens, cookies and clipboard/page content are
redacted by key name. Cookie *values* are never returned by any endpoint - the
admin view shows per-domain counts only. Failed logins log the attempted username
and IP; successful ones log the user id.

Audit table: logins (including failures), logouts, tab create/close/navigate,
permission grants and revocations, user management, browser restarts, cookie
clears, uploads. Input events are deliberately not audited - thousands of rows a
second with no forensic value.

## Before exposing this to the Internet

LAN-first is the default and the safe configuration. For Internet mode:

1. `SESSION_SECRET` from `openssl rand -hex 32`; strong admin password.
2. Terminate TLS at a reverse proxy; set `SECURE_COOKIES=1` and `TRUST_PROXY=1`.
3. Set `TRUSTED_ORIGINS` to your exact public origin - do not rely on the
   private-range default.
4. Put the proxy's own rate limiting in front of `/api/auth/login`.
5. Consider `DEFAULT_TAB_PERMISSION=view` so control is granted deliberately.
6. Remember what a shared browser is: everyone with control shares one cookie
   jar and can act as whoever is logged in inside it. Treat access to this
   service as access to every account that browser is signed into.

## Known limitations

- No MFA, no SSO, no password-reset flow (admins reset passwords).
- No end-to-end encryption inside the LAN: plain HTTP unless you add TLS.
- One shared Chromium means one shared cookie jar by design. Per-user isolation
  is a `Target.createBrowserContext` seam, documented but not implemented.
- mDNS answers A queries without full conflict resolution; another host claiming
  the same `.local` name would be a nuisance. It is optional and off by default
  in Compose.
- `--no-sandbox` as discussed above.
