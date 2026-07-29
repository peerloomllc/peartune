# Running the PearTune host on macOS or Windows

**Status:** technical-first install paths (proposal 2026-07-18 host-platform-expansion).
**Question this answers:** "I want to run the PearTune host on my Mac or Windows PC — how?"

The PearTune host is a small always-on daemon: it holds the allow-list, gates
connections, and serves your library over HyperDHT so your phone reaches it from
anywhere with no port forwarding.

> **New to PearTune?** [`getting-started.md`](getting-started.md) walks the whole thing
> end to end with screenshots - install, point it at your music, pair a phone, revoke a
> device. This page is just the install half.

## Which path — and the one caveat that decides it

- **The desktop app (recommended).** A menubar (macOS) / tray (Windows) app that runs
  the host for you, starts at login and opens the dashboard in your browser. No
  terminal, no Node, nothing to configure. **Start here** unless you have a reason not
  to - the rest of this page is for people running it headless on a server.
- **Native Node.** Run the host directly with Node. The right answer for a headless
  box, a VM or anything without a desktop session. It makes the outbound UDP that
  holepunching needs straight from the machine, exactly like the desktop app does.
- **Docker Desktop (works, with a networking caveat).** The same image runs under
  Docker Desktop, but Docker Desktop runs Linux containers inside a **VM with its
  own NAT**, and `network_mode: host` does **not** behave the way it does on Linux
  there. Outbound UDP holepunching may not survive that extra layer of NAT. It's
  fine for trying the dashboard on your LAN, but if pairing/streaming from
  **off-LAN** fails, that's why — use one of the paths above instead.

The dashboard password differs by path, and it is the one real difference between
them:

- **The desktop app binds loopback only** (`127.0.0.1`), so the control panel is
  reachable only from that machine and there is **no password to set or type**. The
  P2P host runs regardless, so phones still pair and stream from anywhere.
- **The native and Docker paths bind `0.0.0.0`** so you can reach the dashboard from
  another machine, and any non-loopback bind gets a password. Set `PEARTUNE_PASSWORD`,
  or leave it and the host **generates one on first run**, prints it, and saves it to
  `<data>/dashboard-password`.

---

## The desktop app

Install it, and that is the whole install step. It runs the same `host/` code every
other path on this page runs, wrapped in a tray app so a non-technical person never
sees a terminal.

- Lives in the menubar / tray with **Open dashboard** and **Quit**, and starts at login.
- Binds the dashboard to loopback, so there is no password.
- Defaults your library to your OS **Music** folder. Change it - or point it at a
  Jellyfin / Subsonic server - from the dashboard, exactly as described in
  [`getting-started.md`](getting-started.md).

**macOS:** a `.dmg` (Apple Silicon and Intel). **Windows:** a `PearTune Setup x.y.z.exe`
installer.

> **Not yet on a downloads page.** PearTune has no public release, so there is no
> installer to download today - the builds are made from this repo. Once the first
> release ships, these land on the GitHub releases page and this section becomes
> "download and open it".

To build one now:

```bash
cd desktop && npm install && npm run build:mac       # dist/*.dmg  (run this ON a Mac)
cd desktop && npm install && npm run build:windows   # dist/*.exe  (cross-builds from Linux via wine)
```

`electron-builder` cannot build a macOS target from Linux, so the `.dmg` has to be
built on a Mac. See [`../desktop/README.md`](../desktop/README.md) for the details.

**Signing, honestly:** the macOS build is signed but **not notarized**, and the Windows
build is unsigned. So macOS Gatekeeper and Windows SmartScreen will both warn on first
open until notarization and a Windows cert are wired up. On macOS, right-click the app
and choose Open to get past it; on Windows, choose "More info" then "Run anyway".

---

## Native — macOS

Needs **Node 20+** (`brew install node@20`, or from nodejs.org).

```bash
# 1. Stage the repo (the host resolves ../protocol and ../client, so keep it whole).
sudo git clone https://github.com/peerloomllc/peartune /opt/peartune
cd /opt/peartune/host && npm ci --omit=dev

# 2. Try it in a terminal first (Ctrl-C to stop):
PEARTUNE_MUSIC="$HOME/Music" \
PEARTUNE_DATA="$HOME/Library/Application Support/PearTune" \
PEARTUNE_HTTP_HOST=0.0.0.0 \
node /opt/peartune/host/index.js
# -> prints the generated dashboard password; open http://<this-mac>:8741
```

**Run at login** with a LaunchAgent — a sample is at
[`host/deploy/com.peerloom.peartune.plist`](../host/deploy/com.peerloom.peartune.plist):

```bash
cp host/deploy/com.peerloom.peartune.plist ~/Library/LaunchAgents/
$EDITOR ~/Library/LaunchAgents/com.peerloom.peartune.plist   # set the paths + music dir
launchctl load ~/Library/LaunchAgents/com.peerloom.peartune.plist
# the generated password lands in ~/Library/Logs/peartune.log on first run
```

`KeepAlive` restarts it on crash and at login. To stop: `launchctl unload …`.

## Native — Windows

Needs **Node 20+** (`winget install OpenJS.NodeJS.LTS`, or from nodejs.org).

```powershell
# 1. Stage the repo and install the host deps.
git clone https://github.com/peerloomllc/peartune C:\peartune
cd C:\peartune\host ; npm ci --omit=dev

# 2. Try it (PowerShell; Ctrl-C to stop):
$env:PEARTUNE_MUSIC="$env:USERPROFILE\Music"
$env:PEARTUNE_DATA="$env:APPDATA\PearTune"
$env:PEARTUNE_HTTP_HOST="0.0.0.0"
node C:\peartune\host\index.js
# -> prints the generated dashboard password; open http://<this-pc>:8741
```

**Run at login / as a service:** the simplest reliable option is
[NSSM](https://nssm.cc/) (the Non-Sucking Service Manager):

```powershell
nssm install PearTune "C:\Program Files\nodejs\node.exe" "C:\peartune\host\index.js"
nssm set PearTune AppEnvironmentExtra PEARTUNE_MUSIC=C:\Users\you\Music PEARTUNE_DATA=C:\ProgramData\PearTune PEARTUNE_HTTP_HOST=0.0.0.0
nssm start PearTune
```

(Task Scheduler with an "At log on" trigger works too; NSSM gives you crash-restart
and a real service.)

### Without installing Node at all

If you install the **desktop app** (`PearTune Setup x.y.z.exe`) you already have a
Node runtime on the machine - Electron's - and the host is plain Node, so you can
run the daemon with the app's own binary and skip the clone and the `npm ci`
entirely. `ELECTRON_RUN_AS_NODE=1` is what turns the app into `node`:

```powershell
& $env:LOCALAPPDATA\Programs\PearTune\PearTune.exe $env:LOCALAPPDATA\Programs\PearTune\resources\app.asar\vendor\host\index.js --music "$env:USERPROFILE\Music" --data "$env:USERPROFILE\.peartune"
```

[`host/deploy/run-host-windows.cmd`](../host/deploy/run-host-windows.cmd) wraps
that, including the incantation to start it detached. This is the headless daemon,
NOT the tray app - use it on a spare machine or a VM where nobody is going to be
looking at a menubar. Note that launching the tray app itself over SSH does not
work: a GUI process started from an SSH session never reaches the interactive
desktop, so it exits. This path has no such problem.

---

## Docker Desktop (macOS or Windows)

The published image runs under Docker Desktop. Use the generic compose from
[`host/deploy/docker-compose.yml`](../host/deploy/docker-compose.yml) — but **read the
networking caveat at the top of this page first.** If off-LAN pairing doesn't work,
it's the Docker Desktop VM's NAT; switch to the native path above.

```bash
mkdir peartune && cd peartune
curl -O https://raw.githubusercontent.com/peerloomllc/peartune/master/host/deploy/docker-compose.yml
# edit the /music mount to a folder Docker Desktop can see (a shared drive/folder)
docker compose up -d
docker compose logs        # generated dashboard password
```

On Docker Desktop you also have to grant file sharing for whatever folder you mount
at `/music` (Docker Desktop → Settings → Resources → File sharing).

---

## If you already run Jellyfin / Nextcloud / a Subsonic server here

You don't have to serve a folder — point PearTune at that server instead. Its
dashboard **auto-detects** a music server on the same machine and offers to pre-fill
the address, so on the Music Source panel you can usually just tap the detected
server and enter your credentials. (Manually, it's `http://localhost:<port>` — 8096
for Jellyfin, 4533 for Navidrome, etc.)

## Verifying it works

1. Open `http://<this-machine>:8741`, log in with the password from the logs.
2. Pair a phone by scanning the dashboard QR.
3. Browse, play, seek — **on your LAN and off it** (mobile data). Off-LAN playback
   proves holepunching works from this machine (the thing the native path protects).
4. Revoke the phone from the dashboard mid-song: within a second its next track /
   browse / art all fail. That's the host being the sole authority on who gets in.

## Moving a library between machines

Move the **data dir** (`PEARTUNE_DATA`) and every already-paired phone keeps working
with no re-pair — it carries the identity and the grant store. Point the new
machine's music at the same files and you're done.

## What is left on the desktop app

The app itself is built and runs; what remains is distribution polish, and it is worth
being precise about which is which:

- **macOS notarization.** The build is signed but not notarized, so Gatekeeper still
  warns on first open.
- **A Windows signing certificate.** The build is unsigned, so SmartScreen warns.
- **A published release** to download it from, rather than building it yourself.

None of these change how the host behaves - they change how much friction a stranger
hits installing it.
