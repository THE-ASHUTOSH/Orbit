# Deployment

## Quick start

```bash
./orbit up          # generates .env, builds, waits for healthy, prints the LAN URL
```

or by hand:

```bash
cp .env.example .env
# edit .env: SESSION_SECRET (openssl rand -hex 32) and ADMIN_PASSWORD
docker compose up --build
```

`./orbit help` lists the operational commands (users, logs, restart, bench, backup).

Then, from any device on the same network, open `http://<server-lan-ip>:3030`.

Compose refuses to start if `SESSION_SECRET` or `ADMIN_PASSWORD` is unset - that
is deliberate, not a bug.

The image is ~1.6 GB: Chromium is most of it, plus CJK and emoji fonts so pages
render correctly rather than as tofu boxes. Dropping `fonts-noto-cjk` from the
Dockerfile saves roughly 200 MB if you never browse CJK content.

## Finding the server's LAN address

| OS | Command |
|---|---|
| Linux | `ip -4 addr show scope global \| grep inet` |
| macOS | `ipconfig getifaddr en0` (Wi-Fi) or `ipconfig getifaddr en1` |
| Windows | `ipconfig` → "IPv4 Address" of the active adapter |

The server also prints it at startup:

```json
{"level":"info","msg":"listening","url":"http://192.168.1.100:3030","host":"0.0.0.0","port":3030}
```

Use an address on the same subnet as your clients (`192.168.x.x`, `10.x.x.x`,
`172.16-31.x.x`). A `100.x` address is usually Tailscale/CGNAT, and a `169.254.x`
address means DHCP failed.

## Firewall

Inbound TCP 3030 must be allowed on the server.

```bash
# Linux, ufw
sudo ufw allow 3030/tcp

# Linux, firewalld
sudo firewall-cmd --add-port=3030/tcp --permanent && sudo firewall-cmd --reload
```

**macOS**: Docker Desktop publishes ports through its own VM; the first
connection may raise a firewall prompt for `com.docker.backend` - allow it.
System Settings → Network → Firewall → Options must not be set to "block all
incoming connections".

**Windows**: allow the port for the *Private* profile:

```powershell
New-NetFirewallRule -DisplayName "Orbit" -Direction Inbound `
  -LocalPort 3030 -Protocol TCP -Action Allow -Profile Private
```

Many Wi-Fi networks (guest, hotel, some corporate) enable *client isolation*,
which blocks device-to-device traffic entirely. If one device can reach the
server and another cannot, test with both on Ethernet or a phone hotspot before
suspecting the app.

## Platform notes

**Linux** is the primary target: `docker compose up -d` and done. For `.local`
discovery, switch to host networking (multicast does not cross a bridge):

```yaml
services:
  app:
    network_mode: host      # remove the `ports:` block when using this
    environment:
      MDNS_ENABLED: 'true'
```

**macOS / Windows (Docker Desktop)** run containers in a VM. Port publishing
works, host networking and multicast generally do not, so use the IP address.
Give Docker Desktop at least 4 CPUs and 4 GB (Settings → Resources) - Chromium
plus the encoder wants it.

**Raspberry Pi / arm64** works; the image is architecture-independent and Debian
ships arm64 Chromium. Lower expectations: `MAX_FPS=15`, `VIEWPORT_WIDTH=1024`,
`VIEWPORT_HEIGHT=640`, `STREAM_QUALITY=55`.

## Configuration

Everything is environment variables; `.env.example` documents each one. The ones
that matter most:

| Variable | Default | Why you would change it |
|---|---|---|
| `SESSION_SECRET` | *(required)* | signs session cookies; changing it logs everyone out |
| `ADMIN_PASSWORD` | *(required)* | bootstrap admin, first start only |
| `VIEWPORT_WIDTH` / `_HEIGHT` | 1920×1080 | pixels streamed per tab; 1280×720 roughly halves CPU and bandwidth |
| `MAX_FPS` | 45 | CPU and bandwidth, linearly; 30 is fine for reading |
| `STREAM_QUALITY` | 100 | JPEG quality 1-100. LAN-friendly; use 70-80 over the Internet |
| `MAX_TABS` / `MAX_USERS` | 20 / 50 | resource ceilings |
| `DEFAULT_TAB_PERMISSION` | `control` | `view` makes control opt-in per tab |
| `TAB_OWNERSHIP` | `true` | a tab belongs to whoever opened it; others watch until granted control. `false` restores the shared free-for-all |
| `CHROMIUM_HEADLESS` | `false` | headed (normal browser) vs cheaper headless |
| `MDNS_ENABLED` | `true` (env) / `false` (compose) | `.local` name; needs host networking |
| `SECURE_COOKIES` / `TRUST_PROXY` | `false` | set both behind an HTTPS proxy |
| `TRUSTED_ORIGINS` | *(empty)* | exact origins for Internet mode |

**`CHROMIUM_HEADLESS=false` is the default** and runs a real headed browser on a
virtual display, which the container's entrypoint starts (Xvfb on `:99`). This
matters because bot-detection services treat headless as an unusual
configuration, and a shared browser is for browsing real sites.

It was originally assumed that headed mode would break simultaneous multi-tab
streaming, because a headed browser only composites the focused *window*. That
turned out to be wrong once each tab is given its own window
(`Target.createTarget({ newWindow: true })`): measured 4/4 tabs streaming at 30fps
in both modes. What headed actually costs is CPU and memory - see
[performance.md](performance.md#headed-vs-headless). Set `CHROMIUM_HEADLESS=true`
for the cheaper mode.

## Persistence

One volume, `orbit-data`, mounted at `/data`:

```
/data/app.db      users, sessions, tab metadata, grants, audit
/data/profile     Chromium profile: cookies, localStorage, IndexedDB, history
/data/downloads   files the browser downloaded
/data/uploads     files users uploaded for page file-inputs
```

Logins survive `docker compose restart`, `down`/`up`, and image rebuilds.
`docker compose down -v` **deletes all of it**, including every logged-in session
inside the browser.

Backup (stop first so Chromium flushes its profile):

```bash
docker compose stop
docker run --rm -v orbit-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/orbit-backup.tar.gz -C /data .
docker compose start
```

Restore:

```bash
docker compose down
docker run --rm -v orbit-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/orbit-backup.tar.gz -C /data'
docker compose up -d
```

## Operating it

```bash
docker compose ps                     # health status
docker compose logs -f app            # structured JSON logs
curl -s localhost:3030/api/health     # liveness, no auth needed
docker compose restart app            # full restart
docker stats orbit    # live CPU/memory
```

Admins also get, in the UI: browser status and metrics, per-tab detail, user
management, "restart browser" (keeps the profile), cookie domains, and the audit
log. `POST /api/admin/browser/restart` does the same thing headlessly.

## Internet mode

Not required, and not enabled by default. The architecture already supports it:

```
Internet → reverse proxy (TLS) → app:3030 → Chromium
```

Caddy, which is the least work for automatic certificates:

```caddyfile
browser.example.com {
    reverse_proxy localhost:3030
}
```

nginx needs the WebSocket upgrade spelled out:

```nginx
location / {
    proxy_pass http://127.0.0.1:3030;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;   # long-lived sockets
    proxy_buffering off;        # do not buffer the frame stream
}
```

Then:

```env
SECURE_COOKIES=true
TRUST_PROXY=true
TRUSTED_ORIGINS=https://browser.example.com
```

Do not publish port 3030 to the Internet directly, and read
[security.md](security.md#before-exposing-this-to-the-internet) first - a shared
browser is as sensitive as every account it is signed into.

## Running without Docker

```bash
npm install
npm run build
SESSION_SECRET=dev ADMIN_PASSWORD=devpassword DATA_DIR=./data npm start
```

Needs Chromium or Chrome on the host; set `CHROMIUM_PATH` if it is somewhere
unusual. Development mode with hot reload:

```bash
npm run dev     # server on :3030 (tsc --watch), Vite on :5173 proxying to it
```

## Upgrading

```bash
git pull
docker compose up -d --build
```

The image is rebuilt, the volume is kept: tabs are recreated at their last URLs
and browser logins persist. Zero-downtime deployment is out of scope - there is
one shared browser, and restarting it is visible to everyone using it.
