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

**[Download it from the releases page.](https://github.com/peerloomllc/peartune/releases/latest)**
Take `PearTune-x.y.z-arm64.dmg` for Apple Silicon, `PearTune-x.y.z.dmg` for Intel, or
`PearTune-Setup-x.y.z.exe` for Windows.

**Signing, honestly:**

- **macOS is signed and notarized by Apple**, so it opens normally - no right-click, no
  "unidentified developer".
- **Windows is not signed yet**, so SmartScreen warns "unknown publisher" on first run.
  Choose **More info -> Run anyway**. A signing certificate is on the list; it changes
  nothing about how the host behaves.

The Windows installer asks for **administrator rights**, because it registers PearTune as
a background service so your library keeps serving when you are signed out.

### An encrypted disk changes what "always on" means

Both platforms can run PearTune as a background service that keeps serving after you sign
out. Neither can serve anything while the disk it lives on is still locked.

- **macOS with FileVault on** (check with `fdesetup status`). After a restart or a power
  cut the drive stays encrypted at the login window, and nothing stored on it runs -
  PearTune's service included. **Somebody has to unlock the machine before your music is
  reachable again.** Measured on a real Mac mini, 2026-08-11: rebooted 08:05, nothing
  until the disk was unlocked at 09:15, and the host then started itself and served for
  twenty minutes before anyone actually logged in. So it genuinely survives a logout. It
  does not survive a power cut with nobody home.
- **Windows with BitLocker** normally unlocks itself at boot using the machine's TPM, so
  the service starts with no one present. If you have added a startup PIN, you are in the
  same position as FileVault above.
- **A machine with no disk encryption** - which is the usual case for a NAS, an Umbrel or
  a Linux box in a cupboard - just comes back on its own.

This is worth a moment's thought rather than a setting to change. Disk encryption is the
thing protecting your library if the machine is ever stolen. If unattended restarts matter
more to you than that, a machine that lives in a cupboard and holds nothing else is a
better home for the host than your laptop.

The same rule holds on Linux with LUKS, and [`../desktop/README.md`](../desktop/README.md)
has the per-platform measurements behind all of this.

<details>
<summary>Build it yourself instead</summary>

```bash
cd desktop && npm install && npm run build:mac       # dist/*.dmg  (run this ON a Mac)
cd desktop && npm install && npm run build:windows   # dist/*.exe  (cross-builds from Linux via wine)
```

`electron-builder` cannot build a macOS target from Linux, so the `.dmg` has to be built
on a Mac. See [`../desktop/README.md`](../desktop/README.md) for the details.
</details>

---

### Uninstalling (macOS)

Dragging the app to the Trash leaves three things behind: the login item, the Electron
cache, and your library. The app ships an uninstaller that handles all of it:

```bash
bash /Applications/PearTune.app/Contents/Resources/uninstall.sh
```

It stops PearTune, removes the login item and the app, then **asks** before touching your
library - because `host.seed` in there is the identity every paired phone knows this
library by. Keeping it means a reinstall picks up the same library and pairings. Add
`--purge` to remove it too; that takes a verified backup first and tells you how to
restore it.

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

- **A Windows signing certificate.** The build is unsigned, so SmartScreen warns
  "unknown publisher" on first run. This is the last install-friction item.
- **macOS keeps running only while you are logged in.** Linux and Windows install a real
  background service; macOS cannot, because a launchd agent is torn down with its login
  session and running as root would move the library out of your home folder. So on a Mac,
  stay signed in if you want the library reachable.

Done since: macOS is now signed **and notarized** (no Gatekeeper warning), and there is a
published release to download. Neither changes how the host behaves.
