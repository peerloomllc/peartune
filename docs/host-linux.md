# Running the PearTune host on Linux (and any Docker box)

**Status:** technical-first install paths (proposal 2026-07-18 host-platform-expansion).
**Question this answers:** "I don't have an Umbrel — how do I run the PearTune host on my
own NAS / desktop / VPS?"

PearTune's host is a small always-on daemon: it holds the allow-list, gates connections,
and serves your library over HyperDHT. Your phone reaches it with no port forwarding, no
VPN, no account. This page covers four ways to run it on a plain Linux box, easiest first.

**On a Linux desktop, use the desktop app (Option A).** The Docker and systemd paths
below are for a headless box, a NAS or a server.

> On **macOS or Windows**? See [`host-macos-windows.md`](host-macos-windows.md).
>
> **New to PearTune?** [`getting-started.md`](getting-started.md) walks the whole thing
> end to end with screenshots - install, point it at your music, pair a phone, revoke a
> device. This page is just the install half.

## The one thing that is not optional: outbound UDP

The host reaches the DHT by **outbound UDP holepunching** — that is the whole "no port
forwarding" pitch. A normal machine behind a home router does this fine. The only gotcha is
**Docker's bridge network**, which is a second layer of NAT that kills holepunching (measured
on Umbrel, twice). So every Docker path below uses `network_mode: host`. A native (non-Docker)
install has nothing in the way and just works.

## The dashboard needs a password (and will make you one)

The dashboard can revoke devices and open a pairing window onto your whole library, so any
non-loopback bind (`0.0.0.0`, a LAN IP) requires a password. You have two choices:

- **Set `PEARTUNE_PASSWORD`** to pick your own, or
- **Leave it unset** — on first run the host **generates** a strong password, prints it, and
  saves it to `<data>/dashboard-password` (mode 0600). It stays the same across restarts.

A loopback-only bind (`127.0.0.1`, reached over an SSH tunnel) stays password-free.

**Option A does not apply here at all.** The desktop app binds loopback, so it has no
password to set, generate or type.

---

## Option A — the desktop app (AppImage or .deb)

If this machine has a desktop, this is the easiest path by a wide margin. It runs the
same `host/` code as every option below, wrapped in a tray app: **Open dashboard** and
**Quit**, starting at login, no terminal at any point.

It binds the dashboard to loopback, so there is **no password to set or type** - the
control panel is reachable only from this machine. The P2P host runs regardless, so
phones still pair and stream from anywhere. Your library defaults to your `~/Music`
folder and you change it from the dashboard.

- **AppImage** - download, `chmod +x`, run. No install, no root, works on any distro.
- **.deb** - for Debian/Ubuntu, if you would rather it be a package.

**[Get both from the releases page.](https://github.com/peerloomllc/peartune/releases/latest)**

```bash
chmod +x PearTune-*.AppImage && ./PearTune-*.AppImage      # AppImage
sudo dpkg -i peartune-desktop_*_amd64.deb                  # .deb
```

**The `.deb` sets it up as a proper background service**, so your library keeps serving
after you log out and starts again at boot. The AppImage runs as a login-item tray app
instead; to give it the same treatment, run `peartune-desktop --install-service` once.

<details>
<summary>Build it yourself instead</summary>

```bash
cd desktop && npm install && npm run build:linux   # -> dist/*.AppImage and dist/*.deb
```

See [`../desktop/README.md`](../desktop/README.md).
</details>

Note the Linux builds are unsigned, and on a Wayland desktop you may need `--disable-gpu`
if the tray icon misbehaves.

**Not a desktop machine?** Skip to Option B. A tray app needs a desktop session, and
launching it over SSH does not work - a GUI process started from an SSH session never
reaches the interactive desktop and simply exits.

## Option B — Docker Compose (recommended for a server)

The published image runs anywhere Docker does. Grab the compose file from `host/deploy/`:

```bash
mkdir peartune && cd peartune
curl -O https://raw.githubusercontent.com/peerloomllc/peartune/master/host/deploy/docker-compose.yml
# edit docker-compose.yml: point the /music mount at your library
docker compose up -d
docker compose logs        # <- your generated dashboard password is printed here
```

Then open `http://<this-box>:8741`, log in, and pair your phone by scanning the QR.

Key lines in that compose file:

- `image: …@sha256:…` — pinned by digest, multi-arch (amd64 + arm64).
- `network_mode: host` — required (see above); note there is **no** `ports:` mapping as a result.
- `- /srv/music:/music:ro` — **change the left side** to your library. Read-only, always.
- `- ./data:/data` — identity + grants + password. **Back this up.**

To serve an existing Subsonic/Navidrome/Jellyfin library instead of a folder, uncomment the
`PEARTUNE_NAVIDROME_*` lines (they drive the Subsonic adapter; Jellyfin/Emby work too).

## Option C — `docker run` (no compose)

```bash
docker run -d --name peartune-host \
  --network host --restart unless-stopped \
  --security-opt no-new-privileges:true \
  -e PEARTUNE_HTTP_HOST=0.0.0.0 -e PEARTUNE_HTTP_PORT=8741 \
  -e PEARTUNE_NAME="My Library" \
  -v "$PWD/data:/data" \
  -v /srv/music:/music:ro \
  ghcr.io/peerloomllc/peartune-host:0.2.56
docker logs peartune-host   # generated password
```

## Option D — native + systemd (no Docker at all)

For running it as a plain OS service. Needs **Node 20+** on the box.

```bash
# 1. Stage the repo (the host resolves ../protocol and ../client, so keep it whole).
sudo git clone https://github.com/peerloomllc/peartune /opt/peartune
cd /opt/peartune/host && sudo npm ci --omit=dev

# 2. A dedicated user + writable data dir.
sudo useradd --system --home /var/lib/peartune --create-home peartune
sudo chown -R peartune:peartune /var/lib/peartune

# 3. Config.
sudo mkdir -p /etc/peartune
sudo cp /opt/peartune/host/deploy/peartune-host.env.example /etc/peartune/peartune-host.env
sudo $EDITOR /etc/peartune/peartune-host.env      # set PEARTUNE_MUSIC at least

# 4. The service.
sudo cp /opt/peartune/host/deploy/peartune-host.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now peartune-host

journalctl -u peartune-host -n 40                 # generated password prints here
```

The unit restarts the host on crash and on boot (`Restart=always`, `WantedBy=multi-user.target`),
runs it unprivileged, and confines writes to `/var/lib/peartune`. If you change `PEARTUNE_DATA`,
change `ReadWritePaths` in the unit to match.

**Ports & upgrades:** the host's `bin` is not published to npm yet, so a native install tracks the
git repo — `git pull && (cd host && npm ci --omit=dev) && systemctl restart peartune-host` to
upgrade. The Docker paths upgrade by re-pulling the image.

---

## Verifying it works

1. Open `http://<box>:8741`, log in with the password from the logs.
2. Pair a phone by scanning the dashboard QR.
3. Browse, play a track, seek — **on your LAN and off it** (mobile data). Off-LAN playback is
   the proof that holepunching works on your network.
4. Revoke the phone from the dashboard mid-song: within a second, its next track / browse / art
   all fail (the current buffered track may finish). That is the host being the sole authority on
   who gets in — the reason it exists.

## Moving a library between machines

A host is a host on every platform. To move your library (Umbrel → Linux, or box → box), move
the **data dir** (`/data` / `PEARTUNE_DATA`). It carries the identity and the grant store, so
every already-paired phone keeps working with no re-pair. Point the new host's music mount at the
same files and you are done.
