# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

Constitution applies. See `/home/tim/peerloomllc/CONSTITUTION.md` for risk tiers, proposal gate, DECISIONS convention, verify gate, and wiki-sync rules.

## Project Overview

PearTune is a peer-to-peer music player for a self-hosted library. The music lives on a machine you own (an Umbrel, a NAS, an old desktop). The phone is a thin client that reaches it over HyperDHT with no port forwarding, no VPN, no dynamic DNS, no account and no cloud copy of your files.

The pitch, in one line: **your music collection, playable anywhere, without exposing your server to the internet.**

Incumbents (Navidrome, Jellyfin, Plexamp) are good at playback. The part users actually complain about is *remote access*, and that is the part PearTune makes trivial.

## What makes this app different from its siblings

Every other PeerLoom app is phone-to-phone. PearTune is the first with a **host**: a process that runs on the machine holding the files, because a phone cannot dial a folder. So this repo ships two things:

1. **The host** (`host/`) - an always-on daemon. Holds the allow-list, gates connections, serves the library.
2. **The app** (`src/`, `worklet/`) - the Android client.

The host is a sibling of PearCircle's `seeder-launcher/`, which is already a Bare worklet run as an always-on Umbrel daemon with a Preact dashboard, a multi-arch Dockerfile and a listing in `peerloom-umbrel-app-store/`. Reuse that pattern; do not reinvent it.

## Status

Wire protocol v1: `proposals/2026-07-13-wire-protocol.md` (T3). **Implemented.**

Milestones 1 and 2 (pair, stream, revoke; Navidrome adapter) are done and
validated on real hardware - TCL + Umbrel + Navidrome, 1358 tracks. Gapless
playback, shuffle/repeat, per-person grants, the app shell (bottom navbar, nav
stack, Android back, Settings, About) and artist browsing all shipped.

Next up is milestone 3 (offline + Autobase ledger) and milestone 4 (ship it).
Work tracked in `TODO.md`, newest decisions in `DECISIONS.md`.

## Architecture

```
┌──────────────────────────────────────────┐
│  PHONE                                   │
│  React Native shell    app/              │
│  WebView React UI      src/ui/           │
│  Bare worklet          worklet/          │
│    - device identity (@peerloom/core)    │
│    - HyperDHT client -> host             │
│    - Autobase ledger (resume/fav/counts) │
│    - pin + LRU audio cache               │
└──────────────────────────────────────────┘
                    │ HyperDHT, Noise-authenticated
                    │ peartune/pair/1, peartune/media/1
┌──────────────────────────────────────────┐
│  HOST (Umbrel / NAS / desktop)   host/   │
│  - hyperdht server + firewall gate       │
│  - grant store (local, NOT replicated)   │
│  - source adapters:                      │
│      Navidrome (Subsonic API)            │
│      raw folder (tag scan)               │
│  - Autobase writer + seeder              │
│  - Preact dashboard (pair, grant, revoke)│
└──────────────────────────────────────────┘
```

## The two rules that matter most

Everything else is a music app. These two are why this is T3, and breaking either is a security bug, not a bug:

1. **The grant store is host-local and never replicated.** If the allow-list lived in the shared ledger, a revoked device could write itself back in. The host is the sole authority on who gets in.

2. **Revoke must kill live connections, not just future ones.** The HyperDHT `firewall` hook only runs at connect time, so revoking a phone mid-song would otherwise do nothing until it reconnected. The host holds `deviceKey -> Set<connection>` and destroys them on revoke. The acceptance test is **"revoke cuts off all NEW access within a second"** — browse, the next track, art, and reconnect are all denied immediately. The current track may play out whatever the phone already buffered (proposal 2026-07-14-graceful-reconnect); that is deliberate, so a network switch does not also stop the music. What revoke must never allow is anything NEW after the cut.

## No bearer tokens, ever

Noise authenticates every HyperDHT connection, so the host learns the client's real device public key for free. There is no password, token or connection string anywhere in this design. If you find yourself adding one, stop: that is the holesail model we explicitly rejected (see DECISIONS 2026-07-13).

## Verify gate

Per Constitution §5, the canonical gate is `npm run verify`. Do not merge red.

Manual smoke on top of the green gate, against the Umbrel on the LAN:
1. Pair an Android phone by scanning the dashboard QR.
2. Browse, play a track, seek.
3. **Revoke the phone from the dashboard mid-song. Within a second: reconnect is denied, and browse / next track / art all fail. The current track may finish its buffer, then playback stops.** (Also: switch the phone between wifi and cellular mid-song — playback must continue, queue intact.)

## Devices

Android test phones (TCL, Pixel) plus the Umbrel on the LAN with Navidrome installed. Per `[[feedback_screenshot_on_tcl]]`: drive adb screenshots and taps on the **TCL**, never the Pixel (that is Tim's real phone).

## The native project is committed AND generated

`android/` is **committed** in this repo (47 tracked files, and `.gitignore` has no `android`
entry) - which is why `./gradlew assembleDebug` works from a fresh checkout with no prebuild
step. It is *also* regenerated by `expo prebuild`, from `app.json` plus the config plugins in
`plugins/`.

So the plugins are the SOURCE and the committed tree is their OUTPUT. Two consequences:

- **Edit the plugin, not the generated file.** A change made directly in `android/` survives
  until the next prebuild and then vanishes. `test/prebuild.test.js` fails if the committed
  WebView-recovery module drifts from `plugins/webview-recovery-source.js`.
- **Every plugin must be idempotent.** Prebuild runs them against an already-generated tree,
  so an unconditional append duplicates itself - `with-android-queries` had done that nine
  times before anyone noticed (fixed 2026-07-22).

Note the suite-wide `CLAUDE.md` rule 5 says `android/` is gitignored. True of the sibling apps,
not of this one.

## Branch Strategy

Always create a branch before starting work. Never commit directly to master. Merge via PR.

## Licensing note

MIT, like the rest of the suite. **Do not take a dependency on `holesail`, `holesail-server`, `holesail-client`, `@holesail/invite` or `@holesail/protocol`** - they are AGPL-3.0 / GPL-3.0 and would drag copyleft across the app. `hyperdht` and `hyperswarm` are MIT and give us what we need directly.
