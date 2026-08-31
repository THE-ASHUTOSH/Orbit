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
   - [Tabs belong to whoever opened them](#tabs-belong-to-whoever-opened-them)
   - [Shortcuts](#shortcuts)
   - [Capture keyboard](#capture-keyboard)
   - [Tabs: everything you can do](#tabs-everything-you-can-do)
   - [Zoom](#zoom)
   - [Full screen](#full-screen)
   - [Bookmarks and history](#bookmarks-and-history)
   - [Downloads: getting a file onto your own computer](#downloads-getting-a-file-onto-your-own-computer)
   - [Uploading a file to a page](#uploading-a-file-to-a-page)
   - [Right-click menu](#right-click-menu)
   - [Extensions](#extensions)
   - [Who else is here, and how it is doing](#who-else-is-here-and-how-it-is-doing)
   - [One thing to remember](#one-thing-to-remember)
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

About five minutes, most of it downloading. Do this once, on one computer.

### First, install Docker

- **macOS / Windows:** download Docker Desktop from docker.com, install it, and
  open it once so it is running (a whale icon appears in your menu bar or tray).
- **Linux:** install Docker Engine using your distribution's instructions.

Check it worked:

```bash
docker --version
```

A version number means you are ready. "command not found" means it is not
installed, or not running yet.

### Then get Orbit and start it

```bash
git clone https://github.com/THE-ASHUTOSH/Orbit.git
cd Orbit
./orbit up
```

That one command does the whole setup:

1. starts Docker if it is not already running,
2. notices there is no `.env` and **creates one** — nothing to write by hand,
3. **generates a random `SESSION_SECRET`** for you; you never see or choose it,
4. asks you to **choose an admin password**, twice, to catch typos (8+ chars),
5. fills in the rest with the settings this project actually runs on,
6. fetches the default extension and **asks whether to install it** — see
   [Extensions](#extensions),
7. builds, waits until the browser is genuinely healthy, and prints both URLs.

```
> no .env yet - creating one
  choose an admin password (8+ chars):
  again:
> wrote .env (chmod 600) - the same settings this project runs on
> building and starting
  open on this machine:  http://127.0.0.1:3030
  open on the LAN:       http://192.168.1.42:3030
```

The first run builds the browser, so give it a few minutes. Later starts take
seconds.

That admin password is for the user `admin`, and it is the only value you
choose. Everything else is optional and changeable later — see
[Settings explained](#6-settings-explained). `./orbit env --template` prints the
file it would write, if you would rather read it first.

> **Why the admin password matters.** Orbit shares one set of website logins
> across everyone who uses it, so whoever gets in can see every account it is
> signed into. Treat it like the key to a shared office. You can change it
> later, and add or remove people, in the Admin panel.

### Open it

You do not have to work this out — `./orbit up` printed both addresses when it
finished:

```
  open on this machine:  http://127.0.0.1:3030
  open on the LAN:       http://192.168.1.42:3030
```

The second one is what you send your team. To see them again at any time:

```bash
./orbit url        # just the addresses
./orbit status     # the same, plus health and live figures
```

If you ever need to find it by hand — the terminal window is long gone, or you
are checking whether it changed — each system reports it differently:

| Host machine | Command to find it |
|---|---|
| macOS | `ipconfig getifaddr en0` (Wi-Fi) or `en1` |
| Windows | `ipconfig` — look for "IPv4 Address" |
| Linux | `hostname -I` |

Everyone opens that address with `:3030` on the end, and signs in with the
username and password you gave them:

```
http://192.168.1.42:3030
```

> **It can change.** That address belongs to the network, not to Orbit — it can
> change when the host machine reconnects to Wi-Fi or restarts. If the link
> stops working for your team, run `./orbit url` again and send the new one.

> **Mac users on Chrome:** if that gives "This site can't be reached —
> ERR_ADDRESS_UNREACHABLE", it is a macOS permission, not a network problem. See
> [the fix](#chrome-on-macos-says-err_address_unreachable).

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

### Tabs: everything you can do

| Action | How |
|---|---|
| New tab | the `+` on the tab strip, ⋮ Menu, or Option/Alt+T |
| Close a tab | the `x` on the tab, or Option/Alt+W |
| Reopen the tab you just closed | Option/Alt+Shift+T |
| Switch tabs | click one, or Option/Alt+1…9 for the first nine |
| Duplicate a tab | ⋮ Menu → Duplicate tab. The copy is yours |
| Rename a tab | double-click it and type a name — useful when four tabs all say "Dashboard" |
| See whose tab it is | hover it: the tooltip shows the title, the address and who opened it |

A loading tab shows a spinning ring in place of its icon, plus a progress line
over the page, so a slow site is distinguishable from a stuck one.

### Zoom

⋮ Menu, at the top. Set a percentage, or click the percentage to snap back to
100%. It also shows the **streamed resolution** at that zoom — what the page is
actually being rendered at.

Zoom is per tab and shared: it changes how the page is rendered, not how your
screen displays it, so anyone else on that tab sees the same thing.

### Full screen

Option/Alt+F, or ⋮ Menu → Full screen. The page fills your screen and Orbit's
tab strip and toolbar stay visible, so you can still switch tabs. Same keys, or
Escape, to leave.

### Bookmarks and history

- **Bookmark this page:** the star in the toolbar. Click again to remove.
- **All of them:** ⋮ Menu → Bookmarks. Entries open in a new tab; `x` removes.
- **History:** ⋮ Menu → History, with a search box — find the page a colleague
  visited last week by typing part of its name.

Both are **shared**: everyone sees the same lists, and what you visit is visible
to your colleagues. The address bar suggests from that history as you type.

### Downloads: getting a file onto your own computer

Worth understanding, because it surprises people. A download is performed by the
*shared* browser, so the file lands on the host machine — not yours. Getting it
to your machine is a second, deliberate step.

1. Click the download link as normal. A notice appears when it finishes.
2. Open **⋮ Menu → Downloads**. The file is listed with its size.
3. Click **Save**. *That* is when it arrives in your own Downloads folder.
4. Click **delete** next to it once nobody needs it, to remove it from the host.

Refresh re-reads the list if a download finished while the panel was open.

> Downloads are shared: anything downloaded stays on the host machine until
> someone deletes it, and everyone can see and save a copy.

### Uploading a file to a page

The reverse works too. When a page asks for a file, Orbit shows a file picker on
**your** device and you choose from your own computer. The file is sent to the
host first and then handed to the page — the shared browser cannot reach into
your filesystem. That explains the brief pause on a large file, and means the
file is briefly on the shared machine. Multiple files work where the page allows.

### Right-click menu

Right-clicking a page gives you Orbit's own menu, not your browser's:

| On a link | On an image |
|---|---|
| Open link in new tab | Open image in new tab |
| Copy link address | Copy image address |

Copied addresses go to your own clipboard. For text, select it and use
⌘C/Ctrl+C as usual. A tab opened from a link belongs to you, like any other.

### Extensions

Orbit runs real Chrome extensions — ad blocker, password manager, clipper — and
they apply to everyone, because there is one browser.

**Using one:** ⋮ Menu → Extensions. Each one has a button that opens its page,
plus **Options** if it has a settings page.

> **Why it opens as a tab.** In a normal browser an extension popup is a small
> floating window, and Chromium draws those as native desktop windows — outside
> the page area that is streamed to you, so a floating popup could never appear
> on your screen. Orbit opens the extension's page as a tab instead: same page,
> same buttons, docked in a tab.

**Installing one (admins only):** paste a Chrome Web Store link — or just the
extension id — into "Store URL or extension id" and click Add, then restart the
browser (⋮ Menu → Admin panel → Browser). Chromium reads extensions only at
startup, so the restart is not optional. Non-admins do not see the Add box.

#### The default extension

Orbit ships with one: **DOM Heist**, from
[Astro-Dude/VibeExtract](https://github.com/Astro-Dude/VibeExtract). Every
`./orbit up` and `./orbit restart` fetches the latest copy and, the first time,
asks whether to install it:

```
> Orbit ships with a default extension:
    DOM Heist 3.2.0
    from https://github.com/Astro-Dude/VibeExtract.git
    it can: activeTab, scripting, webNavigation, storage, downloads, clipboardWrite
  install it? [Y/n]
```

- You are asked **once**; the answer is remembered, so starting Orbit never nags.
- Afterwards an upstream update installs on the next start without asking, and
  the browser restarts only when something actually changed.
- Say no and it is never installed or mentioned again. To be asked afresh,
  delete `.orbit-cache/extensions/<name>.decision`.
- To remove it later: `./orbit ext rm <id>` then `./orbit restart`.

| Setting | Effect |
|---|---|
| `ORBIT_INSTALL_DEFAULT_EXTENSIONS=yes` | install without asking — scripts, unattended machines |
| `ORBIT_INSTALL_DEFAULT_EXTENSIONS=no` | never install, never ask |
| `ORBIT_DEFAULT_EXTENSIONS="<git-url> …"` | which ones are offered; empty means none |

An unreachable repository, a missing `git`, or no terminal to ask at prints a
warning and starts anyway — nothing is installed without an answer.

> **Expect some not to work.** These are real Chrome extensions in a real
> Chromium, and most behave normally — their keyboard shortcuts work too. But
> some will not. An extension whose popup is drawn as a native panel with no web
> page behind it has nothing for Orbit to open, and the panel says "no page".
> Anything that expects to talk to a program installed on your own computer, or
> that wants you to sign in to the browser itself, will not behave as it does at
> home. Trying one costs nothing: install it, look, remove it if it is no use.

### Who else is here, and how it is doing

- **The bottom strip** shows who is signed in, and whether your connection is
  healthy, idle or reconnecting. Reconnecting retries on its own — no reload.
- **Other people's cursors** appear over the page when you are on the same tab.
- **Performance metrics** (⋮ Menu) shows live frame rate and delay.
- **Appearance** (⋮ Menu) cycles light, dark and follow-my-system.

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
./orbit up
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
  running `./orbit up` again.
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
`./orbit up` to apply it. Only two are required; everything else has a
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
| Status stuck at `starting` | give it 45 seconds; then `./orbit logs 50` |
| Container keeps restarting | usually not enough memory. Raise `MEMORY_LIMIT`, or close other heavy apps |
| Works on the host, not from other devices | see [below](#other-devices-cannot-reach-it) |
| Chrome on Mac: `ERR_ADDRESS_UNREACHABLE` | see [below](#chrome-on-macos-says-err_address_unreachable) |
| Page is blank or black | click reload in Orbit's toolbar; if it persists, ⋮ Menu → Admin panel → Browser → restart |
| Text looks soft on a Retina screen | set `DEVICE_SCALE_FACTOR=1.5`, then `./orbit up` |
| Laggy or stuttering | lower `STREAM_QUALITY` to 70 and `MAX_FPS` to 30; fewer open tabs also helps |
| Everyone signed out of websites after a restart | set `PERSIST_SESSION_COOKIES=true` |
| Installed an extension, cannot see it | extensions load when the browser starts: ⋮ Menu → Admin panel → Browser → restart |
| Your own browser's shortcut fires instead of Orbit's | turn on Capture keyboard (Option/Alt+K) |
| Cannot sign in over the ngrok link | see [ngrok problems](#ngrok-the-link-opens-but-i-cannot-sign-in) |
| Forgot the admin password | sign in as another admin and reset it in Admin panel → Users. If you have no admin left, `./orbit down --wipe` wipes everything and starts fresh — including all logins |

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
   [Open it](#open-it). It changes when the host machine reconnects.
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
  ngrok address changed, update the line and run `./orbit up`.
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
| `./orbit up` | start Orbit, and apply any `.env` changes |
| `./orbit status` | is it running and healthy? |
| `./orbit down` | stop it, keep everything |
| `./orbit logs 50` | recent messages, useful when something is wrong |
| `git pull && ./orbit up` | update to the latest Orbit |
| `./orbit down --wipe` | ⚠️ delete everything — all users, logins and history |

Your data — logins, bookmarks, history, users — lives in a Docker volume called
`orbit-data`, separate from the browser itself, so updating Orbit keeps all of
it. To save a copy:

```bash
./orbit backup                      # writes orbit-backup-<date>.tar.gz
./orbit restore orbit-backup-....tar.gz
```

Keep that file somewhere sensible: it contains the browser's saved logins.

A few more the helper script gives you:

| Command | Does |
|---|---|
| `./orbit url` | just the addresses, to paste to your team |
| `./orbit user <name> [role]` | create an account from the terminal |
| `./orbit users` | list everyone |
| `./orbit restart` | restart the browser, keeping everyone signed in |
| `./orbit env` | show the settings in use, with secrets hidden |
| `./orbit help` | everything else |
