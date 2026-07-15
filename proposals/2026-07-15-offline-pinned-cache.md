# Milestone 3, Phase 5: offline — pinned albums, an LRU audio cache, and an offline write-queue

## Goal
Let a phone play music with no connection to the host — recently-played tracks cached
automatically and whole albums pinned on purpose — while keeping revoke meaningful: a
revoked device that comes back online loses its downloads.

## Tier
T3. No wire change and no host change (`media.stream` already carries `offset`/`length`, so
a full or resumable download uses the existing method) — but it **relaxes the effective
meaning of revoke**, which is the security core of this app, so it gets the full gate.
The relaxation is bounded by the purge-on-reconnect control below.

## Background: why this is delicate
PearTune deliberately streams audio *through the live P2P connection* so that revoke cuts
playback (DONE 2026-07-13: "a phone that downloads a track to a file and plays it would
make the headline demo a LIE"). The graceful-reconnect decision (2026-07-14) already
softened this at the edge: a revoked device may finish the track ExoPlayer already
buffered. Offline pinning extends that softening from "the current buffer" to "bytes you
chose to download" — so it needs an explicit, bounded rule.

**The rule (Tim's call, 2026-07-15):** downloads persist and play offline; revoke still cuts
all NEW access *instantly* (no new stream, browse, art, or pin — unchanged); and a revoked
device, the moment it is online again and the host refuses it, **purges its entire audio +
state cache**. A lost phone that never reconnects keeps its downloads — which is physically
unpreventable (the bytes are on a device we cannot reach), and no worse than the same phone
having the files by any other means.

## Scope

### In
**A. Offline write-queue (the safe half, T2-shaped).** Favorites / resume / play-count
writes made while disconnected are optimistic locally and queued in `DATA_DIR/outbox.json`,
then flushed to the host in order on the next successful connect. Today these silently fail
offline. No host change — the `fav.set` / `resume.set` / `count.bump` methods already exist;
the queue just replays them. Idempotent by nature (LWW on the host), so a double-flush is
harmless.

**B. Audio cache + offline playback + the purge (the T3 half).**
- **Disk cache** at `DATA_DIR/audio/<trackId>` with an index `DATA_DIR/cache.json`
  (`trackId -> { size, pinned, lastPlayed, suffix }`). Two buckets share the dir:
  - **LRU auto-cache**: a track played to completion is written through to disk as its bytes
    stream past the shim, so "what you just heard" is offline-playable. Evicted oldest-first
    to stay under a size cap (Settings; default 1 GB).
  - **Pinned**: explicit downloads (below), never auto-evicted; shown and managed separately.
- **The shim serves the cache first.** `worklet/shim.js` already answers the player's Range
  requests from the live client; now it checks disk first — a complete cached/pinned file is
  served from disk (so playback works with no connection), and a miss streams from the client
  and writes through. Write-through only on a full sequential read (offset 0 → end); a seek
  read still streams live (partial-range caching is not worth the complexity in v1).
- **Purge on refused reconnect.** The client's reconnect already distinguishes a host that
  *refused* the connection (the firewall denied it — `conn` closes right after the DHT
  reaches the host, exactly as `pair()` detects a closed pairing window) from a host that is
  *unreachable* (a timeout). On a **refused** reconnect the worklet wipes `audio/`,
  `cache.json`, the state caches (favorites/playlists), and the outbox. On a **timeout** it
  changes nothing (your server being off must never delete your downloads). This is the
  control that keeps revoke meaningful.

**C. Explicit pinning + Downloads UI.**
- Pin an album or a track: the worklet downloads each track's full bytes via `media.stream`
  (resumable — it already takes `offset`/`length`, so an interrupted pin resumes), marks them
  `pinned` in the index, with progress surfaced in the UI. Unpin removes the bytes.
- A **Downloads** surface (in the "You" tab or Settings) lists pinned albums, shows total
  size, and offers unpin. Offline, this is the one place with playable content.
- **Cellular guard**: a "Download over cellular" setting (default OFF) — pinning a FLAC album
  is ~hundreds of MB; the client already knows the network type (expo-network, PR #10), so a
  pin over cellular with the toggle off is refused with a clear message.

### Settings (new)
- Cache size cap for the LRU bucket (500 MB / 1 GB / 2 GB / Unlimited), with current usage.
- "Clear cache" (LRU only) and "Manage downloads" (pinned).
- "Download over cellular" toggle.

### Out (later, flagged)
- **Partial-range caching / caching a seeked track** — v1 caches on full sequential play only.
- **A time-boxed lease** (playback expires N days after the last successful auth, even fully
  offline) as an *additional* hardening on top of purge-on-reconnect. Deferred; the
  purge-on-reconnect already covers "revoked device comes back online," and a never-online
  device is unpreventable either way. Revisit if the guest threat model wants a hard cap.
- **Auto-restore the paused queue on launch** (needs queue persistence; tracked separately).

## Compat / migration
- **Purely additive and client-only.** New files under the phone's data dir; no Hyperbee key,
  no wire framing, no host code. An old host is fine (the client only ever calls the existing
  `media.stream` / `fav.set` / …). Rolling back = stop caching and the app streams live as it
  does today; deleting `audio/` + `cache.json` + `outbox.json` removes the feature with zero
  effect on pairing, grants, or the host.
- The state caches (favorites/playlists) already exist and already render offline; this adds
  the WRITE side (outbox) and the AUDIO side (cache).

## Verify
- **Offline playback**: pin an album, enable airplane mode, play it end to end from disk.
- **Auto-cache**: play a track online, go offline, replay it — served from cache, no host.
- **Revoke purge (the load-bearing test)**: pin an album; revoke the device from the
  dashboard; the device is online → on the next reconnect the host *refuses* it and the app
  **purges** the downloads (they no longer play). Distinct from: stop the host container
  (unreachable) → downloads **survive** and still play offline. Both paths tested on the TCL +
  Umbrel.
- **Revoke still cuts NEW access within a second** (the CLAUDE.md acceptance test) — unchanged:
  browse / next uncached track / art / new pin are all denied immediately on revoke.
- **Write-queue**: favorite a track offline; reconnect; the host shows it favorited; a second
  device (same person) sees it — proving the queued write flushed.
- **Size cap / eviction**: set a small cap, play past it, confirm oldest LRU entries evict and
  pinned entries never do.
- **Cellular guard**: with the toggle off, a pin over cellular is refused with a message.
- `npm run verify` green with unit tests for the cache index (LRU eviction order, pinned
  protected, size accounting) and the outbox (order preserved, flush-once, idempotent replay).

## Rollback
- Client-only and additive; a feature flag gates the cache + outbox. Flipped off, the app is
  today's app (stream-live, no offline). No migration to reverse; the host is untouched, so
  nothing to roll back there.
- If the purge signal proves unreliable in the field (a network hiccup mistaken for a
  refusal), the fallback is conservative — treat an *ambiguous* reconnect failure as a timeout
  (keep the cache), never as a refusal (purge). We would rather under-purge (a revoked device
  keeps downloads a little longer) than delete a paying user's downloads on a bad wifi moment.

## Open questions
1. **The refused-vs-unreachable signal.** `pair()` already relies on it (a closed pairing
   window fires `conn.close`; an absent host times out). This proposal reuses that exact
   distinction for the media reconnect. The risk is a false *refusal* (deleting downloads on a
   transient close). Mitigation: require the refusal to be a clean firewall-style close *after
   the DHT reached the host*, and on any doubt fall back to "timeout" (never purge). Confirm on
   hardware that a real revoke reliably reads as refused and a real host-off reads as timeout.
   If the distinction is ever unreliable, add the time-boxed lease (deferred, above) as the
   robust backstop.
2. **Do guests pin?** v1 lets any granted device pin, backstopped by purge-on-reconnect. If
   the guest leak matters more later, gate pinning to owner-confirmed devices (the person model
   exists; "only my own devices" is a one-line grant check) — flagged, not built.
3. **One size budget or two?** Proposing two: pinned is user-managed (you chose it; shown, not
   capped), LRU is auto and capped. Simpler mental model than one shared budget.

## Phasing (ship incrementally, one proposal)
- **Phase A — offline write-queue.** Independent, no security surface; makes offline
  favorites/resume/counts work. Ship first.
- **Phase B — audio LRU cache + offline playback + purge-on-reconnect + cache settings.** The
  T3 core (the purge lands with the first persisted audio).
- **Phase C — explicit album pinning + Downloads UI + cellular toggle.** Builds on B.
