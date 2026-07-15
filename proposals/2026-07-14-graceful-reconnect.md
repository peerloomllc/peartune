# Graceful reconnect: survive a network switch, relax revoke to "no new access"

**Goal** — A network change (wifi↔cellular, a dead spot) must not stop playback and
wipe the queue. Playback continues across the blip; only a real revoke ends it — and a
revoke ends all NEW access instantly while letting the current track's buffered audio
play out.

**Tier** — T3. It changes revoke semantics, which is one of the two rules the whole app
exists to enforce (CLAUDE.md). Proposal + rollback + a hardware acceptance check
required.

## Why

Observed on the Pixel during the cellular test: switching networks kills the P2P
connection, and the shell reacts by calling `stop()` — which tears down the player AND
clears the queue. So a five-second network blip costs you the whole queue and your
place in it. That is the opposite of "playable anywhere."

The reason it was built this way: from the phone, a revoke and a network drop look
IDENTICAL at the instant of disconnect, and the safe reaction to "maybe revoked" was
"stop everything." That made "revoke stops the music within a second" true and provable
(DONE 2026-07-14), at the cost of making every transient drop just as violent.

## The decision that unlocks it (Tim, 2026-07-14)

**Revoke does not need to cut off the CURRENT track's already-buffered audio. It needs
to cut off everything NEW.** A revoked device may finish the ~20-50s ExoPlayer already
buffered (or the rest of a short track); it may not start the next track, browse,
search, or fetch art or any new bytes. "After this track, they are out."

This is sound against the real threats (lost phone, removed guest, an ex): they hear
the tail of one song, nothing more. Revoke never prevented CAPTURING the current stream
anyway — any player can record what it is playing — so the seconds were about the demo
feeling instant, not about a threat where they matter.

## What distinguishes a revoke from a network switch

They look identical at disconnect, but they DIVERGE ON RECONNECT:
- **Network switch** → the grant is still valid → reconnect SUCCEEDS.
- **Revoke** → the grant is tombstoned → reconnect is DENIED by the firewall.

So the phone does not need to guess at disconnect time. It keeps playing and lets the
reconnect result decide.

## Scope

**What changes**

1. **The shell stops tearing down on `host:disconnected`.** It keeps the player and the
   queue, and lets ExoPlayer keep playing its buffer. (`app/index.tsx`: the
   `if (msg.event === 'host:disconnected') stop()` line is the whole culprit.)
2. **The shim already reconnects on demand** — every request calls `ensure()`, which
   awaits a single-flight reconnect (the "press play on the lock screen after the phone
   slept" path). So ExoPlayer's next chunk request, or its retry of the one that broke
   mid-stream, blocks in the shim until reconnected, then serves from the right Range.
   A network switch becomes a stall bounded by reconnect time, with the buffer covering
   it — often inaudible.
3. **ExoPlayer's load-error policy** is tuned so a transient chunk failure retries
   (through the reconnect) instead of fataling the player.
4. **Revoke ends playback by STARVATION, not teardown.** On revoke, reconnect is
   denied, so the shim can serve no more bytes; the buffer drains and the track stops.
   No new track loads (the load is denied), so the queue cannot advance. The shell
   reacts to the PLAYER erroring / running dry — not to `host:disconnected` — and only
   THEN stops, clears, and says "access ended."
5. **Copy updates.** CLAUDE.md's acceptance test and the DONE/DECISIONS wording change
   from "playback must stop within a second" to "all NEW access must stop within a
   second (browse, next track, art, reconnect all denied); the current track may play
   out its buffer."

**What does NOT change**

- The transport, pairing, grant store, the firewall, and `revokeDevice` killing live
  connections. The HOST behavior is untouched; this is entirely client reaction.
- No offline / downloading. Nothing is persisted for later playback; when the buffer is
  gone and the connection is denied, the music stops. Pure streaming holds.
- Direct-play seeking, the transcode path, everything from the transcoding milestone.

**Optional knob** — "always finish the CURRENT track" (not just the buffered ~50s) by
buffering the whole current track on a revoke. Cheap for a cellular mp3 (~4MB), ~40MB
for a FLAC. Default to the simpler "play out what's buffered"; add this only if a
mid-track cut feels abrupt in practice.

## Compat

- Pure client change; old and new phones interoperate with any host. No wire change.
- A phone on the OLD build keeps stopping-and-clearing on a switch; a NEW build rides
  through it. Both enforce revoke (the new one by starvation, the old one by teardown).

## Verify

- **The headline acceptance test, revised, on hardware:** revoke the phone mid-song from
  the dashboard. Within a second: browsing fails, the next track will not start, art
  stops loading, and reconnect is denied. The current track may finish its buffer, then
  playback stops and the app says access ended. (This is the T3 check; it must pass
  before merge.)
- **Network switch on the Pixel:** play a track, toggle wifi↔cellular mid-song. Playback
  continues (a brief stall at most), the queue and position survive, and it advances to
  the next track normally.
- **Background suspend** (the existing case): still reconnects on resume, unchanged.
- `npm run verify` green; a worklet/shim test for "a request that arrives mid-reconnect
  awaits the reconnect and then serves" if it can be exercised under Bare.

## Rollback

- One behavioral switch (react to `host:disconnected` or not). Reverting the shell to
  call `stop()` on disconnect restores the old stop-and-clear exactly, with no data or
  protocol migration. Keep the revert a one-liner.

## Open questions

- **How long does ExoPlayer actually keep the buffer playing when its DataSource stalls
  mid-load?** If it fatals too eagerly, we may need a custom load-error policy or to
  hold the shim response open (heartbeat) during the reconnect rather than letting the
  request break. Measure on device.
- **Do we PAUSE at the buffer edge and auto-resume on reconnect, or hard-stop?** For a
  reconnect that takes longer than the buffer, a pause-then-resume is nicer than a stop.
  Depends on whether ExoPlayer will resume a stalled source cleanly.
- **The "you were revoked" message vs "you went through a tunnel."** Only say access
  ended after a reconnect is actually DENIED, never merely delayed — the same rule the
  background-disconnect work already set (DECISIONS 2026-07-14).
