# Orbit — Team Guide

Everything you need to run Orbit and use it with your team. No prior knowledge
assumed. If you only want to *use* it and someone else is hosting, skip to
[Using Orbit](#4-using-orbit).

**What Orbit is:** one real Chrome-style browser running on one machine, shared
with everyone on your network. Each person works in their own tabs, at the same
time, in the same browser. One set of logins, shared by all of you — sign in to
something once and everyone has it.

**What it is not:** screen sharing. Nobody has to "present", and you are not
watching someone else's cursor. Everyone browses independently.

---

## Contents

1. [What you need](#1-what-you-need)
2. [Set it up](#2-set-it-up)
3. [Add your team](#3-add-your-team)
4. [Using Orbit](#4-using-orbit)
5. [Use it from anywhere with ngrok](#5-use-it-from-anywhere-with-ngrok)
6. [Settings explained](#6-settings-explained)
7. [Troubleshooting](#7-troubleshooting)
8. [Everyday commands](#8-everyday-commands)

---

## 1. What you need

**The host machine** — one computer that runs Orbit. It does all the work.

| | |
|---|---|
| Operating system | macOS, Windows or Linux |
| Software | Docker (installed once, see below) |
| Free CPU / memory | 4 cores and 4 GB is fine; 6 and 6 is comfortable |
| Network | on the same Wi-Fi or LAN as your team |

**Everyone else** — nothing at all. Just a browser: laptop, phone, tablet.

Leave the host machine on and awake while people are using it. On a laptop,
plug it in — sleeping the machine stops the browser for everybody.

---

## 2. Set it up

About five minutes, most of it downloading.

### Step 1 — Install Docker

- **macOS / Windows:** download Docker Desktop from docker.com and install it.
  Open it once so it is running (you will see a whale icon in your menu bar or
  system tray).
- **Linux:** install Docker Engine using your distribution's instructions.

Check it worked — open Terminal (macOS) or PowerShell (Windows) and run:

```bash
docker --version
```

You should see a version number. If you see "command not found", Docker is not
installed or not running yet.

### Step 2 — Make a folder for Orbit

```bash
mkdir orbit
cd orbit
```

### Step 3 — Get the setup file

```bash
curl -fsSL https://raw.githubusercontent.com/THE-ASHUTOSH/Orbit/main/docker-compose.hub.yml -o docker-compose.yml
```

That is a small text file describing how to run Orbit. Nothing else to download
by hand — the browser itself comes in the next step.

### Step 4 — Create your settings file

You need exactly two values to start: a random secret, and an admin password.

Generate the secret:

```bash
openssl rand -hex 32
```

Copy the long string it prints. Now create a file named `.env` in the same
folder, containing:

```bash
SESSION_SECRET=paste-the-long-random-string-here
ADMIN_PASSWORD=pick-a-strong-password
```

Notes:

- **`SESSION_SECRET`** keeps your sign-ins valid. Any long random string works.
  Never share it.
- **`ADMIN_PASSWORD`** is your own password for signing in the first time. Make
  it a real password — on a shared browser, whoever gets in sees every account
  the browser is signed into.
- On Windows without `openssl`, this works instead:
  `docker run --rm alpine sh -c "head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'"`

Everything else has a sensible default. [Settings explained](#6-settings-explained)
covers what you can change later.

### Step 5 — Start it

```bash
docker compose up -d
```

The first run downloads the browser image — about 475 MB, which unpacks to
roughly 1.8 GB on disk. Give it a few minutes on a normal connection. Later
starts take seconds.

Check that it is ready:

```bash
docker compose ps
```

Look for **healthy** in the status column. If it says `starting`, wait 30
seconds and run it again.

### Step 6 — Open it

On the host machine itself:

```
http://localhost:3030
```

From anyone else's device, you need the host machine's address on the network:

| Host machine | Command to find the address |
|---|---|
| macOS | `ipconfig getifaddr en0` (Wi-Fi) or `ipconfig getifaddr en1` |
| Windows | `ipconfig` — look for "IPv4 Address" |
| Linux | `hostname -I` |

It looks like `192.168.1.42` or `172.20.1.240`. Everyone opens:

```
http://192.168.1.42:3030
```

Sign in with the username `admin` and the `ADMIN_PASSWORD` you chose.

> **Mac users on Chrome:** if that address gives you "This site can't be
> reached — ERR_ADDRESS_UNREACHABLE", it is a macOS permission, not a network
> problem. See [the fix](#chrome-on-macos-says-err_address_unreachable).

---

## 3. Add your team

You do not create accounts from the command line — do it in the app.

1. Sign in as `admin`.
2. Click the **⋮ Menu** button (top right).
3. Choose **Admin panel**.
4. Open the **Users** section and add each person with a username, a password
   and a role.

Then send each person the address and their username and password.

### Roles

| Role | Can do |
|---|---|
| **admin** | everything, including managing users, extensions and any tab |
| **user** | open tabs, browse, type — the normal role for a teammate |
| **viewer** | watch only; can never type or click in a page |

The other Admin panel sections are **Tabs** (see and close any tab), **Extensions**
(install Chrome extensions for everyone), **Browser** (restart the browser) and
**Shared browser state** (what the browser is signed into).

---

## 4. Using Orbit

It behaves like a browser. The parts worth knowing:

### Tabs belong to whoever opened them

Open a tab and it is yours. Others can *see* it, but cannot type in it — so
nobody types into your form by accident.

- To use someone else's tab, click **"Ask <name> for control"** in the toolbar.
- They see a small box in the corner of that same tab: **"Can I drive this
  tab?"** with **Give control** and **Keep it to myself**.
- Give control and you both can type in it.

### Shortcuts

Orbit's own shortcuts use **Option** on a Mac and **Alt** on Windows and Linux —
so they never fight with your own browser's shortcuts.

| Shortcut | Does |
|---|---|
| Option/Alt + T | new tab |
| Option/Alt + W | close tab |
| Option/Alt + D | jump to the address bar |
| Option/Alt + F | full screen |
| Option/Alt + K | capture keyboard (below) |
| Option/Alt + ← / → | back / forward |
| Option/Alt + 1…9 | switch to that tab |

Copy and paste are **normal**: ⌘C/⌘V on a Mac, Ctrl+C/Ctrl+V on Windows. They
work between Orbit and your own computer in both directions.

### Capture keyboard

Some shortcuts belong to your own browser — Ctrl+T opens a tab in *your*
browser, not in Orbit. Turn on **Capture keyboard** (⋮ Menu, or Option/Alt+K)
and those keys go to Orbit instead.

It applies to that one tab only, and only while you are on it. Turn it off the
same way. You will see a small badge when it is on.

### The rest of the menu

| Menu item | What it is for |
|---|---|
| Zoom | make the page bigger or smaller (top of the menu) |
| New tab / Duplicate tab | as it sounds |
| Full screen | the page fills your screen, controls stay visible |
| Bookmarks / History | shared by everyone using Orbit |
| Downloads | files downloaded in the shared browser, for you to save |
| Extensions | install from the Chrome Web Store; needs a browser restart |
| Appearance | light, dark, or follow your system |
| Performance metrics | live frame rate and latency, if you are curious |
| Sign out | ends your session only, not anyone else's |

### One thing to remember

**Logins are shared.** If you sign in to Gmail in Orbit, everyone using Orbit is
signed in to that Gmail. That is the point of the tool — and the thing to be
careful about. Do not sign in to anything personal you would not hand to the
whole team.

---

## 5. Use it from anywhere with ngrok

By default Orbit is reachable only on your own network. ngrok gives it a
temporary public web address, so someone at home or in another office can use
it.

### Steps

**1. Install ngrok** — download from ngrok.com, or on a Mac:

```bash
brew install ngrok
```

**2. Sign up free** at ngrok.com, copy your authtoken from the dashboard, and
run it once:

```bash
ngrok config add-authtoken YOUR_TOKEN_HERE
```

**3. Start the tunnel** (Orbit must already be running):

```bash
ngrok http 3030
```

It prints a line like:

```
Forwarding   https://random-words-1234.ngrok-free.app -> http://localhost:3030
```

That `https://...` address is your public link.

**4. Tell Orbit it is behind HTTPS.** Add these three lines to your `.env`,
using your own ngrok address:

```bash
TRUSTED_ORIGINS=https://random-words-1234.ngrok-free.app
SECURE_COOKIES=true
TRUST_PROXY=true
```

Then apply them:

```bash
docker compose up -d
```

**5. Share the `https://` link** and each person's username and password.

### What each of those three lines does

| Setting | Why |
|---|---|
| `TRUSTED_ORIGINS` | tells Orbit this public address is legitimately yours. Without it, requests coming through some proxies are refused for safety |
| `SECURE_COOKIES` | your sign-in cookie is only sent over HTTPS |
| `TRUST_PROXY` | ngrok sits in front, so Orbit reads the real visitor address from it (used for its own rate limiting) |

### Things to know before you do this

- **⚠️ Turning on `SECURE_COOKIES` breaks the plain `http://192.168...` address.**
  Browsers refuse to store a secure cookie over plain HTTP, so people on your
  own network can no longer sign in there — everyone uses the `https://ngrok`
  link instead. Going back to local-only means removing those three lines and
  running `docker compose up -d` again.
- **The free ngrok address changes** every time you restart ngrok, and you have
  to update `TRUSTED_ORIGINS` each time. ngrok's free plan includes one reserved
  domain — set it up in their dashboard and use
  `ngrok http --url=your-name.ngrok-free.app 3030` so the address stays put.
- **It will feel slower.** Everything you click travels to the host machine and
  back. On the same network that is a few milliseconds; from another country it
  can be 200 ms or more, which is fine for reading and clicking but noticeably
  laggy when typing.
- **Anyone with the link can try passwords against it.** Use strong passwords,
  remove people you no longer want (Admin panel → Users), and stop ngrok
  (Ctrl+C in its window) when you are done for the day.
- **Remember the shared logins.** A public link means a public door to every
  account that browser is signed into. Sign out of anything sensitive first.

---

## 6. Settings explained

All settings live in your `.env` file. Change a line, then run
`docker compose up -d` to apply it. Only two are required; everything else has a
default.

### The two you must set

| Setting | Plain meaning | Example |
|---|---|---|
| `SESSION_SECRET` | random string that keeps sign-ins valid. Changing it signs everyone out | `f3a9…` (from `openssl rand -hex 32`) |
| `ADMIN_PASSWORD` | your password for the first admin account. Used only when the database is empty — changing it later does nothing | `a-strong-passphrase` |

### Everyday ones

| Setting | Plain meaning | Default | Try |
|---|---|---|---|
| `APP_PORT` | which port to open it on. Change it if 3030 is taken | `3030` | `3040` |
| `HOME_URL` | the page new tabs open on | Google | `https://intranet.company.com` |
| `VIEWPORT_WIDTH` / `HEIGHT` | the page size everyone sees, in pixels. Bigger fits more on screen but makes text smaller | `1920` × `1080` | `1600` × `900` for bigger text |
| `DEVICE_SCALE_FACTOR` | sharpness. Same layout, drawn with more pixels. 1 to 3, decimals allowed. Only helps on high-resolution (Retina) screens, and uses more bandwidth | `1` | `1.5` on Retina |
| `STREAM_QUALITY` | picture quality, 1–100. Lower means less bandwidth | `80` | `70` for slow networks |
| `MAX_FPS` | how smooth motion is. Lower uses less CPU | `30` | `45` for video |
| `PERSIST_SESSION_COOKIES` | keep everyone signed in to websites when Orbit restarts | `true` | `false` to always start signed out |
| `TAB_OWNERSHIP` | tabs belong to whoever opened them. Off means anyone can type in any tab | `true` | leave on |
| `MAX_TABS` / `MAX_USERS` | limits, so one busy day cannot overwhelm the machine | `20` / `50` | — |
| `CPU_LIMIT` / `MEMORY_LIMIT` | how much of the host machine Orbit may use | `4.0` / `4g` | `6.0` / `6g` if you have it |
| `CHROMIUM_TIMEZONE` | what time zone websites think you are in | `UTC` | `Asia/Kolkata` |

### Only when publishing it beyond your network

| Setting | Plain meaning |
|---|---|
| `TRUSTED_ORIGINS` | the public web address you are serving Orbit on |
| `SECURE_COOKIES` | send sign-in cookies over HTTPS only |
| `TRUST_PROXY` | something (ngrok, nginx, Cloudflare) sits in front of Orbit |

### Leave these alone unless you have a reason

`DEVTOOLS_ENABLED` gives admins developer tools inside the shared browser.
Anyone who opens it can read what any page holds, including other people's
signed-in sessions. It ships off, and off is the right default.

---

## 7. Troubleshooting

### Quick table

| What you see | What to do |
|---|---|
| `docker: command not found` | Docker is not installed, or Docker Desktop is not open yet |
| `set SESSION_SECRET in .env` when starting | your `.env` is missing, empty, or not in the folder you ran the command from |
| `port is already allocated` | something else uses 3030. Put `APP_PORT=3040` in `.env`, restart, use `:3040` |
| Status stuck at `starting` | give it 45 seconds; then `docker compose logs --tail 50` |
| Container keeps restarting | usually not enough memory. Raise `MEMORY_LIMIT`, or close other heavy apps |
| Works on the host, not from other devices | see [below](#other-devices-cannot-reach-it) |
| Chrome on Mac: `ERR_ADDRESS_UNREACHABLE` | see [below](#chrome-on-macos-says-err_address_unreachable) |
| Page is blank or black | click reload in Orbit's toolbar; if it persists, ⋮ Menu → Admin panel → Browser → restart |
| Text looks soft on a Retina screen | set `DEVICE_SCALE_FACTOR=1.5`, then `docker compose up -d` |
| Laggy or stuttering | lower `STREAM_QUALITY` to 70 and `MAX_FPS` to 30; fewer open tabs also helps |
| Everyone signed out of websites after a restart | set `PERSIST_SESSION_COOKIES=true` |
| Installed an extension, cannot see it | extensions load when the browser starts: ⋮ Menu → Admin panel → Browser → restart |
| Your own browser's shortcut fires instead of Orbit's | turn on Capture keyboard (Option/Alt+K) |
| Cannot sign in over the ngrok link | see [ngrok problems](#ngrok-the-link-opens-but-i-cannot-sign-in) |
| Forgot the admin password | sign in as another admin and reset it in Admin panel → Users. If you have no admin left, `docker compose down -v` wipes everything and starts fresh — including all logins |

### Chrome on macOS says ERR_ADDRESS_UNREACHABLE

You open `http://172.20.1.240:3030` and Chrome says *"This site can't be
reached… is unreachable. ERR_ADDRESS_UNREACHABLE"*, but the same link works in
Safari.

This is **not** a network or Orbit problem. Recent macOS asks each app for
permission to talk to devices on your local network, and Chrome has been denied.
macOS blocks the connection before it reaches the network, so Chrome reports it
as an unreachable address rather than "permission denied" — which is why it
looks like a routing fault. Safari is exempt, so it keeps working.

Fix it in this order:

1. **System Settings → Privacy & Security → Local Network** → turn **Google
   Chrome** on. Then quit Chrome completely (⌘Q — closing the window is not
   enough) and reopen it.
2. **If Chrome is not in that list, or the toggle is already on and it still
   fails**, reset the permission from inside Chrome: go to
   `chrome://settings/content/localNetworkAccess`, choose *"Don't allow sites to
   connect to any device on your local network"*, wait about 10 seconds, then
   switch to *"Sites can ask…"* and click **Allow** on the prompt. This
   re-triggers the macOS prompt that never appeared.
3. **If both fail**, the permission is stuck in macOS's cache. In Terminal run
   `tccutil reset All com.google.Chrome`, then **reboot** — the reset alone will
   not take effect, because the denial is cached until restart.

While you are there, confirm both devices are on the same Wi-Fi, and that no VPN
or proxy extension is active in Chrome only — either produces the same error for
a different reason.

### Other devices cannot reach it

Work through these:

1. **Same network?** Phone on mobile data, or a "guest" Wi-Fi that isolates
   devices, will not reach it.
2. **Right address?** Re-check it with the command in
   [Step 6](#step-6--open-it). It changes when the host machine reconnects.
3. **Firewall on the host?** Allow incoming connections on port 3030:
   - macOS: System Settings → Network → Firewall → Options → allow Docker
   - Windows: Windows Defender Firewall → Allow an app → Docker Desktop
   - Linux: `sudo ufw allow 3030/tcp`
4. **Still nothing?** On the host, `curl -s localhost:3030/api/health` should
   print `{"status":"running",...}`. If it does, Orbit is fine and the problem is
   between the devices.

### ngrok: the link opens but I cannot sign in

Two usual causes:

- **`TRUSTED_ORIGINS` does not match.** It must be the exact address including
  `https://` and no trailing slash — `https://abc-123.ngrok-free.app`. If your
  ngrok address changed, update the line and run `docker compose up -d`.
- **You are on the plain `http://` address with `SECURE_COOKIES=true`.** The
  browser will not keep the sign-in cookie. Use the `https://ngrok` link, or
  remove `SECURE_COOKIES` to go back to local use.

If the sign-in page will not even load, check that ngrok is still running — the
free tunnel closes when you close its window or your laptop sleeps.

---

## 8. Everyday commands

Run these in your Orbit folder.

| Command | Does |
|---|---|
| `docker compose up -d` | start Orbit, and apply any `.env` changes |
| `docker compose ps` | is it running and healthy? |
| `docker compose stop` | stop it, keep everything |
| `docker compose logs --tail 50` | recent messages, useful when something is wrong |
| `docker compose pull && docker compose up -d` | update to the latest Orbit |
| `docker compose down -v` | ⚠️ delete everything — all users, logins and history |

Your data — logins, bookmarks, history, users — lives in a Docker volume called
`orbit-data`, separate from the browser image, so updating Orbit keeps all of
it. To copy it somewhere safe:

```bash
docker run --rm -v orbit-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/orbit-backup.tar.gz -C /data .
```

---

Running Orbit from the source code instead of the published image? The
[README](../README.md) covers the `./orbit` helper script, which wraps all of
the above plus benchmarks and user management from the terminal.
