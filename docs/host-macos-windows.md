# Running the PearTune host on macOS or Windows

**Status:** technical-first install paths (proposal 2026-07-18 host-platform-expansion).
**Question this answers:** "I want to run the PearTune host on my Mac or Windows PC — how?"

The PearTune host is a small always-on daemon: it holds the allow-list, gates
connections, and serves your library over HyperDHT so your phone reaches it from
anywhere with no port forwarding. It's plain Node, so it runs on macOS and Windows
today. This page covers the two ways to do it. A polished menubar/tray app is a
planned follow-on (see the end); until then this is the technical path.

## Which path — and the one caveat that decides it

- **Native (recommended).** Run the host directly with Node on your Mac/Windows.
  It makes the outbound UDP that holepunching needs straight from the machine, so
  the "reach it from anywhere" pitch works exactly as designed. This is the
  reliable choice.
- **Docker Desktop (works, with a networking caveat).** The same image runs under
  Docker Desktop, but Docker Desktop runs Linux containers inside a **VM with its
  own NAT**, and `network_mode: host` does **not** behave the way it does on Linux
  there. Outbound UDP holepunching may not survive that extra layer of NAT. It's
  fine for trying the dashboard on your LAN, but if pairing/streaming from
  **off-LAN** fails, that's why — use the native path instead.

The dashboard password works the same on both: any non-loopback bind (`0.0.0.0`)
gets a password, and if you don't set `PEARTUNE_PASSWORD` the host **generates one
on first run**, prints it, and saves it to `<data>/dashboard-password`.

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

## The polished app (planned follow-on)

A menubar (macOS) / tray (Windows) app that starts the host, opens the dashboard,
and runs at login — no terminal — is a planned follow-on. It's deferred because the
real cost there is **code signing + notarization** (an Apple Developer account on
macOS, a signing cert on Windows) and bundling the Node runtime, not the host
itself. This technical path exists so you don't have to wait for it.
