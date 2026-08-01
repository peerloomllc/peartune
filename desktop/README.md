# PearTune Desktop

The PearTune **host** as a menubar / tray app for macOS, Windows, and Linux — so a
non-technical user runs it without a terminal. It wraps the same
[`host/`](../host/) code the Umbrel and Docker installs run. (Start9 is not a supported
target — see [`../start9/README.md`](../start9/README.md) for the measurement that tabled
it.)

## Does it keep running when you log out?

**On Linux and Windows, yes. On macOS, no — and it cannot.** This page used to call the
app "the always-on daemon" on all three, which was not true of any of them, so here is
what each one actually does:

| platform | how it runs | survives logout / reboot with no login |
| --- | --- | --- |
| **Linux** | systemd **user** service + `loginctl enable-linger` | **yes** — measured: booted with nobody logged in, host serving 5s later, same library identity |
| **Windows** | a `LocalSystem` service, registered by the installer | **yes** — measured: rebooted with nobody logged in, service running, same library identity |
| **macOS** | tray app, started as a login item | **no** — and it cannot without root. See below. |

On **Windows** the installer does it all: it registers the service, points it at the
library you already have, and starts it. Two things worth knowing:

- The install now needs **admin** (a UAC prompt), because registering a service does.
- The service is pointed at your existing library rather than given a copy of it. Copying
  was tried and does not work: the storage stamps itself with the file's identity on
  disk, so any copy refuses to open. One consequence is that the service reads *your*
  user profile — so it is tied to the account that installed it.

On **Linux**, the `.deb` installs and starts the service for you. For the AppImage — or if
the install could not tell who to set it up for — run it yourself:

```bash
peartune-desktop --install-service     # writes the unit, enables it, starts it
peartune-desktop --uninstall-service   # stops and removes it; your library is untouched
```

Linger is the part that matters and it needs root, so `--install-service` tells you when
it is missing rather than claiming success: `sudo loginctl enable-linger $USER`. Without
it the unit still dies at logout, which is the thing this exists to fix.

**Why macOS is different, since it looks like it should work the same way.** A launchd
LaunchAgent is torn down with its login session. Measured 2026-07-31 with a `KeepAlive`
agent logging every 10s across one logout: last beat, 48 seconds of silence, then a
*different* process at the next login. `KeepAlive` restarts a job that exits; it does not
exempt one from its domain being destroyed. Running with nobody logged in would need a
root LaunchDaemon, which moves the data dir out of `~/Library/Application Support`, puts
your Music folder behind permissions, and runs the LAN code with no user session — where
PearTune already has a scar, because hardened runtime silently blocks HyperDHT's raw UDP.
So macOS stays a tray app, deliberately.

## What it does

- Runs the PearTune host — a background service, no app window. Like the
  PearCal/PearCircle seeders, you reach it through your browser.
- Lives in the tray/menubar (Open dashboard · Quit). When a Linux service already owns
  the host, the tray notices and runs as a **client** instead of starting a second one —
  two hosts on one data dir is a corruption risk, not a cosmetic clash — and its menu
  says so, because "Quit" then only closes the icon and leaves the music playing.
- "Open dashboard" (and a manual launch) opens `127.0.0.1:8741` in your real browser.
- Binds the dashboard to **loopback** (`127.0.0.1`) — the control plane is only
  reachable from this machine, so there's no password to type. The P2P host
  (HyperDHT) runs regardless, so phones pair and stream from anywhere as usual.
- Defaults the library to your OS **Music** folder; change it (or point at a
  Jellyfin/Subsonic server) from the dashboard.

Unlike PearCal's Electron app there's no Bare worklet — the host is plain Node, so
the Electron main requires it directly. `scripts/prepack.js` stages `../host`,
`../protocol`, `../client` into `vendor/` so the subproject is self-contained for
electron-builder; the host's native deps live in `node_modules` here and ship
cross-platform prebuilds (which is what lets Windows cross-build from Linux).

## Develop

```bash
cd desktop
npm install          # postinstall runs prepack (stages vendor/)
npm start            # or: npm run start:dev-linux
```

## Build installers

**macOS is signed AND notarized; Windows and the AppImage are unsigned.** So macOS opens
with no warning at all, while Windows shows a SmartScreen "unknown publisher" prompt on
first run. A Windows signing certificate is the one remaining distribution item.

```bash
npm run build:linux      # AppImage + .deb, native, this box
npm run build:windows    # NSIS .exe, cross-built from Linux via wine
```

Output lands in `dist/`.

### macOS

`electron-builder` **cannot** build a macOS target from Linux. Run the mac build on
the **mac-mini** the other PeerLoom apps use (same host/creds pattern as PearCircle /
PearCal):

```bash
# on the Mac:
cd desktop && npm install && npm run build:mac    # dist/*.dmg (arm64 + x64)
```

`package.json#build.mac` carries a real signing `identity`, `hardenedRuntime: true` and
`notarize: true`. `build-mac.sh` stages the App Store Connect key from `scripts/.env` onto
the Mac (notarytool is macOS-only) and warns loudly rather than silently shipping an
un-notarized build if the key is missing. `spctl` reports
`accepted / source=Notarized Developer ID`.

The old comment here claimed notarization was impossible because hardened runtime blocks
HyperDHT's LAN traffic. That was measured and is false - see DECISIONS 2026-08-01.

## Uninstalling

| platform | how |
| --- | --- |
| **macOS** | `bash /Applications/PearTune.app/Contents/Resources/uninstall.sh` |
| **Windows** | the usual Add/Remove Programs entry (its uninstaller removes the service) |
| **Linux** | `sudo apt remove peartune-desktop`, or `peartune-desktop --uninstall-service` for the AppImage |

All three **keep your library by default** - `~/Library/Application Support/peartune-desktop/data`
on macOS, `%APPDATA%\peartune-desktop\data` on Windows, `~/.config/peartune-desktop/data`
on Linux. `host.seed` in there is the identity every paired phone knows the library by and
nothing regenerates it, so removing the app must not cost someone their pairings. The macOS
script takes `--purge` to wipe it, after a verified backup.

## Not committed

`node_modules/`, `vendor/` (regenerated by prepack), and `dist/` are gitignored.
