# Running the PearTune host on Linux (and any Docker box)

**Status:** technical-first install paths (proposal 2026-07-18 host-platform-expansion).
**Question this answers:** "I don't have an Umbrel — how do I run the PearTune host on my
own NAS / desktop / VPS?"

PearTune's host is a small always-on daemon: it holds the allow-list, gates connections,
and serves your library over HyperDHT. Your phone reaches it with no port forwarding, no
VPN, no account. This page covers three ways to run it on a plain Linux box, easiest first.

> On **macOS or Windows**? See [`host-macos-windows.md`](host-macos-windows.md).

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

---

## Option A — Docker Compose (recommended)

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

## Option B — `docker run` (no compose)

```bash
docker run -d --name peartune-host \
  --network host --restart unless-stopped \
  --security-opt no-new-privileges:true \
  -e PEARTUNE_HTTP_HOST=0.0.0.0 -e PEARTUNE_HTTP_PORT=8741 \
  -e PEARTUNE_NAME="My Library" \
  -v "$PWD/data:/data" \
  -v /srv/music:/music:ro \
  ghcr.io/peerloomllc/peartune-host:0.2.3
docker logs peartune-host   # generated password
```

## Option C — native + systemd (no Docker at all)

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
