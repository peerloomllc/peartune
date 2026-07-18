# Host platform expansion (Start9, Linux, macOS, Windows)

## Goal

Broaden **where the PearTune host can run** beyond the Umbrel/Docker path, so the
pitch — *"your music lives on a machine you own (an Umbrel, a NAS, an old
desktop)"* — is true for more than Umbrel owners. This is the agreed prerequisite
to the next big feature (multi-source / multi-host): broaden *where the host runs*
before adding complexity to *what it serves*, because packaging is lower
architectural risk and does not entangle with the source-scoped-`trackId` dedup
problem multi-source needs.

Scope decided with Tim (2026-07-18): **HOST platforms only.** These targets are
places the always-on daemon runs; the phone stays the client. A desktop *client*
(playing music on the laptop itself) is explicitly out — it roughly doubles the
work and overlaps the deferred iOS/client-parity effort.

Distribution philosophy decided with Tim: **technical-first.** Ship the Docker /
CLI / systemd paths so technical self-hosters can run it now; the polished signed
desktop tray app is a follow-on, not a blocker.

## Tier

**T2.** This is packaging + a new Start9 surface + a desktop distribution surface.
It adds **no wire/protocol change** and **no change to the two load-bearing rules**
(the grant store stays host-local; revoke still kills live connections) — packaging
runs the same `host/` code. The one thing that would have made it T3 — a first-class
auth model for a non-Umbrel install — is **already done** (proposal
2026-07-14-dashboard-auth): `createAuth` is a real password login (session cookie,
failure lockout, timing-safe compare) and `requireSafeBind` fail-closed refuses to
bind anything but loopback unless a password is set. So the security posture already
holds off-Umbrel; this proposal does not touch it.

## Background: what already exists, and what we reuse

Two findings make this much smaller than it looks:

1. **The host is a plain Node CLI, already designed for this.** `host/index.js` is
   a `#!/usr/bin/env node` CLI with a `bin` entry, and its own header already names
   the roadmap: *"On an Umbrel this is the container entrypoint; on a desktop it is
   what the tray app wraps."* Config comes from flags or env
   (`PEARTUNE_MUSIC`, `PEARTUNE_PASSWORD`, host/port). Nothing about the runtime is
   Umbrel-specific.

2. **The suite already has the templates.** The PearTune host is modeled on
   PearCircle's `seeder-launcher`, and:
   - `pearcircle/seeder-launcher/start9/manifest.yaml` — the seeder is **already
     packaged for StartOS**. Direct template for a PearTune s9pk.
   - `pearcal-native/electron` + `pearcal-native/desktop` + `pearguard/desktop` —
     the suite already has the Electron/tray desktop pattern the host header
     anticipates.
   - Wiki: `cross-platform-parity.md`, `linux-cross-build-quirk.md` for build gotchas.

## Shared prerequisite: a fresh multi-arch image

Start9 and every Docker-based path (Linux, and the technical macOS/Windows path)
wrap the **same** multi-arch image, which is currently **stale** — it predates the
source picker, and Tim's box has only ever received `docker cp`'d files, never a
rebuilt image (see TODO Milestone 4 + the many "RELEASE-GATE NOTE" entries in
DONE/DECISIONS). So this effort pulls the **M4 fresh-image publish** forward as its
first step, rather than treating it as separate:

- Rebuild the multi-arch (amd64 + arm64) image to GHCR, **baking in everything since
  PR #6** — including this session's host-side changes: the analog-amber dashboard
  recolour (`host/ui/dashboard.html`, `host/ui/login.js`), the new brand icon
  (`umbrel/icon.svg`), the green connected-dot + logo dashboard tweaks, plus the
  earlier session's host files (presence.js, state/media/server, protocol framing,
  logprune, sort adapters, etc.).
- Re-pin the compose digest.
This image is the artifact all the container-based platforms below consume.

## Shared technical risk: holepunch connectivity per platform

The whole pitch is "no port forwarding" — the host reaches HyperDHT via **outbound
UDP holepunching**. On Umbrel this forced `network_mode: host` (bridge NAT killed
holepunching — measured twice; see dashboard-auth). The per-platform question is
always the same: *can the host make the outbound UDP the DHT needs?*
- Native desktop (Linux/macOS/Windows): yes — a normal process behind a home router
  makes outbound UDP fine. This is the pitch working as designed.
- Containerized (Start9): must replicate the host-networking / DHT reachability the
  Umbrel package needs. The seeder's Start9 package already solved this — reuse its
  net config and verify.
Each platform's acceptance test below includes "pair a phone and stream from off the
LAN" precisely to prove holepunch works there.

## Scope, per platform

### 1. Linux (lowest effort — mostly done)
- **Docker:** the existing image + a compose file already run anywhere Docker does.
  Deliverable is documentation + the re-pinned image, not code.
- **Native:** the host already has a `bin`, so `npx`/a global install works for
  technical users. Add a sample **systemd unit** for always-on, and document the
  `PEARTUNE_MUSIC` / `PEARTUNE_PASSWORD` env. `requireSafeBind` already forces a
  password for any non-loopback bind; on first run with a non-loopback bind and no
  password set, the host **generates-and-prints** one (persisted to the data dir) so
  a bare install works without a platform to mint `${APP_PASSWORD}` (see Resolved).
- **Bundled binary: out for v1** (Docker/CLI is enough — see Resolved).

### 2. Start9 (medium effort, high reuse)
- Adapt `pearcircle/seeder-launcher/start9/manifest.yaml` → a PearTune `start9/`
  s9pk that wraps the fresh multi-arch image: manifest (id/title/version/marketing),
  config spec (music path, password → StartOS `${APP_PASSWORD}` equivalent), health
  check, volume for `/data` (grant store — host-local, never replicated) + the music
  mount, and the network/holepunch config from the seeder.
- **Auth:** like Umbrel, StartOS's proxy cannot front a host-networked service, so
  use the built-in password login (already present). Wire StartOS's generated
  password in.
- **Test on hardware:** Tim's Start9 box (returned-feline.local, i5-7500T/16GB — see
  `[[peartune-selfhost-hardware]]`). **Distribution: sideload the s9pk for v1** (not
  a community-registry publish — see Resolved). Acceptance: sideload the s9pk, set
  the music path + password, pair the TCL, stream on-LAN and off-LAN, revoke mid-song.
- **Reach note (from the 2026-07-14 platform survey):** Start9's registry has only
  Jellyfin + Nextcloud Music, so on Start9 the Jellyfin + Subsonic adapters are what
  make PearTune useful at all — good fit, existing adapters cover it.

### 3. macOS / Windows (technical-first now; tray app follow-on)
- **Now (technical):** the Docker Desktop path + the Node CLI, documented. This gets
  it into the hands of technical self-hosters on those OSes without new code.
- **Follow-on (polished):** a menubar/tray app that starts the host, opens the
  dashboard, and runs at login — adapting `pearcal-native/electron`. The real cost
  lives here and is why it's deferred: bundling the Node runtime, **code signing +
  notarization** (macOS needs an Apple Developer account, $99/yr; Windows needs a
  cert), and auto-start. Tracked as its own follow-on with its own proposal when we
  get there.

## Compat / migration

- No data or wire change. A host is a host on every platform; the grant store
  (`/data`) and `source.json` shapes are unchanged, so a library can move between
  platforms by moving its data dir.
- The device-facing protocol is identical, so existing paired phones keep working
  regardless of where the host is moved.

## Verify (per platform, on real hardware)

The canonical gate (`npm run verify`) is unchanged — this is packaging. Acceptance
is per-platform hardware smoke, each proving the same invariants:
1. Install via the platform's mechanism; set music path + password.
2. Pair the TCL by QR from the dashboard.
3. Browse, play, seek — **on-LAN and off-LAN** (proves holepunch on that platform).
4. Revoke mid-song from the dashboard: within a second, reconnect + next track + art
   all denied (the CLAUDE.md revoke gate), current buffer may finish.
- Linux: also verify the systemd unit restarts the host on boot.
- Start9: also verify the s9pk config (music path, password) round-trips.

## Rollback

Each platform package is additive and independent. Nothing here changes the running
Umbrel deployment except the shared fresh image (which is a strict improvement over
the stale one). Reverting a platform = not publishing that package.

## Sequencing

1. **Fresh multi-arch image → GHCR + re-pin digest** (shared unblocker; overdue).
2. **Linux** (document Docker/compose + native CLI + systemd) and **Start9** (adapt
   the seeder s9pk, test on returned-feline.local) — both wrap the image, high reuse.
3. **macOS/Windows technical path** (document Docker Desktop + CLI).
4. **Desktop tray app** — separate follow-on (its own proposal; signing/notarization).
Then: multi-source / multi-host.

## Resolved (Tim, 2026-07-18)

- **Start9 distribution: SIDELOAD for now.** Ship the s9pk as a sideload, not a
  community-registry publish, for v1. "Done" for Start9 = a working sideloadable
  s9pk verified on returned-feline.local; registry publish is a later step.
- **Linux binary: DOCKER for now.** No bundled single-file binary in v1 — the
  Docker/compose path (+ the `bin` CLI for technical users) is enough. Revisit only
  if demand shows.
- **Password UX off-Umbrel: GENERATE-AND-PRINT on first run.** If a non-loopback
  bind is requested with no `PEARTUNE_PASSWORD` set, the host generates a password on
  first run and prints it (persisting it to the data dir), rather than aborting. A
  loopback-only bind stays password-free; an explicitly-set password always wins.
  This keeps `requireSafeBind`'s fail-closed guarantee (a LAN-exposed dashboard is
  never unauthenticated) while making a bare NAS/Linux install work without an
  Umbrel/Start9 platform to mint `${APP_PASSWORD}`.
- **Registry/versioning: confirmed.** Standard tag/version scheme for the multi-arch
  GHCR image; the existing `umbrel/` listing publishes against the fresh digest.
