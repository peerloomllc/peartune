# One device plays, and "Continue listening" tells the truth

**Goal** - a phone that is playing without the session token stops as soon as it learns another
of your devices is playing, and the "Continue listening" card stops being hijacked by a device
that was offline.

**Tier** - T2. New persisted fields on the resume row and a new optional param on `resume.set`.

## Why

Reported by Tim 2026-07-30 ("two of one person's devices can play different tracks at once, and
it confuses continue listening"), then reproduced on the TCL + Pixel against the Umbrel, both
devices granted to one person. Two separate defects, both measured:

1. **The claim is a one-shot.** `sessionActivate` is called from exactly one place - the
   transition into playing (`app/index.tsx:387`) - and a failed claim is never retried. A device
   that cannot reach its library at that instant (offline, playing a downloaded album) plays with
   no token. Worse, a device that does not hold the token stops talking to the host about the
   session at all (`sessionActive ? sessionTarget() : null`, `src/bare.js:2935`), so it has no
   path back. Measured: TCL offline playing a download, Pixel presses Play and claims, both
   `state=PLAYING(3)` for 70s; TCL back on wifi, reconnects, and keeps playing while its own
   `sessionInfo` reads `active:false, activeDeviceName:"Pixel", activePlaying:true`.

2. **The outbox rewrites history to the front.** Offline, `resume.set` is queued to the per-host
   outbox and drained on reconnect. The host stamps `updatedAt = Date.now()` at WRITE time, so a
   device that was offline lands its old positions with a newer timestamp than the device playing
   right now, and `latestResume` - which is the person's newest row by `updatedAt` - picks it.
   Measured: with the Pixel playing "Strange Encounters", the Pixel's own `resumeLatest` answered
   `{"title":"Interspace","pos":214877}`, the other phone's offline track. This needs no
   simultaneous playback; one device returning from offline is enough.

The token mechanism itself is fine and stays. Both directions of a normal handoff were verified
working, sub-second, before any of this.

## Scope

**Reconcile (defect 1).** A device that is PLAYING but does not hold the token re-checks the
session on the heartbeat that already fires (`saveQueueState`, ~4s, sync target lookup so it
never dials):

- the row says we are the active device -> adopt it, nothing else changes;
- the row exists, belongs to another device, and that device is `playing` -> we lost; report
  `lostSession`, which the shell already handles by stopping (`onHandedOff`);
- otherwise (no row, or the holder is stopped/paused) -> claim it, because we are the one
  actually playing.

Gating the stop on the holder's `playing` flag is deliberate. The token deliberately persists as
last-known after a device stops, so that another device can still "Play here"; without the gate a
week-old token would kill offline playback on reconnect. The flag must also be FRESH - a device
force-quit mid-song never writes `playing:false` and leaves a row insisting forever that it is
playing, so the stop needs the row to be younger than a liveness window (60s, against a ~4s
heartbeat). Stale means dead, and a dead holder loses the token rather than silently stopping
someone else's music.

**Continue listening (defect 2).** Two changes:

- `resume.set` accepts an optional `playedAt` (the client's clock, when it was actually
  listened to). The host stores it and `latestResume` orders by `playedAt ?? updatedAt`, so a
  late outbox flush cannot jump the queue.
- The resume row records the `deviceKey` that last wrote it - host-derived from the
  authenticated connection, never client-sent. `latestResume` prefers rows written by the ASKING
  device, and falls back to the person's newest only when the asking device has no rows at all
  (so a freshly paired phone still gets a card). The explicit cross-device affordance is the
  "Playing on <name>" / "Play here" handoff card, which is untouched.

**Not in scope.** The merged-vs-single session split (`session:merged:{owner}` vs
`session:{owner}`, `host/state.js:308`) is a real second way two devices can both play - they
hold different rows and can never supersede each other - but it did not cause what Tim saw (both
his phones have one library each) and it is a separate design question. Left in TODO.md.

## Compat

- `playedAt` and `deviceKey` are ADDITIVE fields on `resume:{ownerId}:{trackId}`. Rows written
  before this have neither; `latestResume` falls back to `updatedAt` for ordering and treats a
  row with no `deviceKey` as belonging to nobody, so it is only ever a fallback candidate. No
  migration, no rewrite.
- An OLD host ignores the extra `resume.set` param (unknown params are already ignored) and
  answers `resume.latest` without `playedAt`. The client sorts on `playedAt ?? updatedAt`, so it
  degrades to exactly today's behavior.
- An OLD client sends no `playedAt`; the host stamps `playedAt = updatedAt`. Its `resume.latest`
  reply gains a field it does not read.
- The reconcile is client-side only and uses `session.get` / `session.claim`, which already
  exist. On a host too old for them, `sessionSupportedFor` is already false and nothing runs.

## Verify

- `npm run verify` green.
- Unit: `latestResume` prefers the asking device; a late flush with an older `playedAt` does not
  win; a row with no `playedAt` orders by `updatedAt`; an unknown device falls back to the
  person's newest.
- Unit: reconcile adopts / stops / claims for each of the three branches.
- On hardware, the exact reproduction above: TCL offline playing a download, Pixel claims, TCL
  back on wifi -> TCL must stop within a heartbeat, and the Pixel's `resumeLatest` must stay on
  its own track.

## Rollback

Two independent halves; either can be reverted alone. Reverting the reconcile restores the
one-shot claim. Reverting the card change leaves the extra fields on disk, unread and harmless.

## Open questions

- When the reconcile stops a device, it goes through `stop()`, which WIPES that device's queue -
  the same thing the existing instant-presence handoff does. Consistent, but it means an offline
  phone loses its queue on reconnect. Keeping it consistent for now; revisit if it bites.
