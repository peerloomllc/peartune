# Cross-device session handoff ("Play here")

## Goal
Let a person move an in-progress listening session — the same queue, the same track, the
same spot — from one of their devices to another with a deliberate **"Play here"**, instead
of the queue being trapped on whichever phone built it.

## Tier
T2. New persisted host state (a `session:{ownerId}` row) and new methods on the existing
`peartune/media/1` channel. No new swarm, no wire-framing change, no new identity. Old peers
degrade via `ENOMETHOD` (a host without session support keeps today's per-device queue). Not
T3: this rides the same host-derived-owner model as favorites/resume, adds no new access
surface, and revoke still governs it — a revoked device can neither read nor claim a session.

## Background: why the queue is NOT already synced, and what "sync" should actually mean
The four things host-as-hub syncs today (favorites, resume, counts, playlists) are *facts
about the library*: the same truth on every device, changed rarely, one obvious value each.
That is why single-writer + last-write-wins works for them.

The play queue is the opposite of all three. It is **session state**, not library state: it
mutates constantly (every skip, reorder, and the position tick), it *conflicts* (LWW would
mean the last device to touch its queue clobbers the other's — a live phone at the gym
overwritten by an idle tablet's stale queue), and it is contextual to where you physically
are. Naively replicating the live queue trades a real, low-cost win we ALREADY have (resume
= "pick up where you left off") for constant write traffic and cross-device surprise.

So this proposal deliberately does **not** build an ambient synced queue. It builds
**explicit handoff with a single active player** — which is the part people actually want
("start on my phone, continue on my tablet") without the tug-of-war. Two design moves make
it cheap and conflict-free:

1. **Position rides the resume mechanism we already have.** The hard, high-frequency part —
   millisecond position within the current track — is NOT replicated live. Handoff lands the
   receiving device at the current track's last-saved *resume* position (already synced,
   already throttled to 8s, phase-2). We only add sync for the queue *list* (contents, order,
   index, shuffle/repeat), which changes on user actions — the same low write profile as a
   playlist edit.
2. **One active device at a time, claimed explicitly.** The session carries an
   `activeDeviceKey` and a monotonic `generation`. A device pushes queue mutations only while
   it holds the token; taking the token is a deliberate "Play here". There is no ambient
   takeover, so there is no "whose position wins" soup — whoever holds the token wins, and
   claiming it is a user act.

This is a sibling of queue-persistence (PR #29), which already rebuilds a queue from
IDs + metadata + index + position and re-resolves shim URLs per launch. Handoff is that same
restore path pointed at the **host's** session row instead of the local `queue.json`:
"restore the queue on a *different* device, on demand" rather than "on the same device, on
launch." The machinery exists.

**Not casting.** Handoff moves the *description* of a session between full PearTune clients,
each of which already streams from the host independently. It is unrelated to Chromecast /
Android Auto (rendering audio on a non-client output), which stay their own backlog items.

## The data tier (same seam the other state uses)
A single-library session is Tier 1: it lives on the host that owns the tracks, addressed as
`session:{ownerId}` exactly like `playlist:{ownerId}:{id}`. A cross-library "what am I
playing across ALL my libraries" is Tier 2 (a per-user object over several hosts) and is
explicitly OUT — the same deferral favorites/playlists already made. The v1 seam: the app
treats the active session as *the one reported by the host it is currently playing from*.

## Scope
**In:**
- **A host session row.** `session:{ownerId}` → `{ queue: [{trackId, ...renderMeta}],
  index, shuffle, repeat, activeDeviceKey, generation, updatedAt }`, in the existing `state`
  Hyperbee. `ownerId` is host-derived (`personId ?? deviceKey`), never client-asserted —
  identical to favorites/resume. IDs + render metadata only, **never shim URLs** (ports
  change per launch; the receiver re-resolves, exactly as queue-restore already does).
- **New media-channel methods** (JSON `{method, params}`; old host → `ENOMETHOD`):
  - `session.get()` → the owner's session row (queue + index + modes + who's active).
  - `session.claim({ generation })` → become the active device via compare-and-set on
    `generation` (host bumps it, stamps `activeDeviceKey` = this connection's device). A
    stale generation loses — this is the conflict primitive.
  - `session.set({ queue, index, shuffle, repeat, generation })` → replace the session, honored
    **only** from the device that currently holds `activeDeviceKey` with a current generation;
    a non-holder's write is rejected (its queue stays local). Reuses the app's existing
    queue-snapshot events (persistQueue's throttle), so no new write cadence.
- **The app:**
  - Starting/continuing playback on a device **claims** the session; thereafter its queue
    changes push `session.set` (throttled, same events that write `queue.json`).
  - A non-active device shows a **"Playing on <device name>"** card with **"Play here"**.
    Tapping it: `session.claim` → on success, rebuild the local ExoPlayer queue from the
    session row (the PR #29 restore path), seek the current track to its resume position, and
    play. The previously-active device, learning it lost the token, pauses.
  - On "Play here", the losing device first flushes an *exact* one-shot resume write for the
    current track, so handoff is seamless despite ambient resume being 8s-granular.

**Out (v1 simplifications, all deferrable on the same rails):**
- **Continuous position streaming.** Handoff lands at the last resume point (≤8s repeat, or 0s
  with the one-shot flush on explicit handoff). No live position mirroring.
- **Instant presence.** How device A learns it was superseded: v1 leans on A's next resume/
  status write getting a "you are no longer active" reply, plus finding out when the user next
  opens it. A real-time push on the media channel is a later nicety, not v1.
- **Mirroring** (two devices holding the queue, one playing). v1 is single active player —
  transfer, not mirror. Mirroring is exactly the conflict surface we are avoiding.
- **Cross-library sessions** (Tier 2). Single library only, like playlists v1.
- **Casting to a non-client output** (Chromecast / Android Auto) — separate backlog.

## Compat / migration
- **Purely additive.** New row family in the existing `state` Hyperbee, new methods on the
  existing channel; media/pairing framing unchanged. A host on old code answers `ENOMETHOD`
  and the app simply keeps today's device-local queue (no "Play here" card). A new host with
  an old app is never asked. Queue-persistence (PR #29) is untouched and remains the local
  fallback and the on-launch restore.
- **No new dependency.** Uses the corestore/Hyperbee the host already runs. No Autobase, no
  second swarm.
- **Assigning a device to a person** moves the session owner key from `deviceKey` to
  `personId`, same as the other tier-1 state; a pre-assignment session simply does not carry
  across the claim (v1 — matches favorites' "start fresh under your name once confirmed").

## Verify
- **Handoff**: build a multi-track queue on phone A, play, skip to track 3, seek. Open phone B
  (same person, same host) → "Playing on A". Tap **Play here** → B rebuilds the queue at track
  3 at ~the right position, and A pauses. The queue and modes match.
- **Single active player / no tug-of-war**: with B active, a queue edit on A (which no longer
  holds the token) does NOT overwrite the session; A's local queue diverges until A claims.
- **Conflict primitive**: two `session.claim` calls racing on the same generation — exactly one
  wins (unit test on the CAS), the loser is told its generation is stale.
- **Owner is host-derived**: a crafted `session.set`/`claim` cannot touch another person's
  session; the host ignores any client-supplied owner and stamps from the connection.
- **Revoke unregressed** (the CLAUDE.md acceptance test): revoke B mid-handoff → its
  `session.claim`/`get` are denied within a second along with all other NEW access; a revoked
  device cannot resurrect a session (and cannot beyond the offline lease).
- **Old-host degrade**: against a host without session support, no "Play here" card appears and
  the local queue + on-launch restore behave exactly as today.
- `npm run verify` green with new unit tests for the CAS/generation token and owner derivation.

## Rollback
- Additive and independent: the media channel stops offering `session.*`, the app hides the
  "Play here" card, and PearTune is today's per-device-queue app. Feature-flagged.
- No migration to reverse; deleting the `session:*` rows removes handoff with zero effect on
  grants, identity, pairing, the media path, or the local queue.

## Resolved (Tim, 2026-07-17)
1. **Presence latency → LAZY for v1.** The previously-active device learns it lost the token on
   its next resume/status write (or next foreground), not via a real-time push. Handoff to the
   new device is instant; the old device stops within ~8s (its next resume tick). A media-channel
   push is a fast-follow, not v1.
2. **Transfer, not mirror.** Single active player: "Play here" plays on the new device and pauses
   the old one. Two devices playing the same queue in parallel is explicitly out (the conflict
   surface the whole design avoids).
3. **Position → one-shot exact flush.** On "Play here", the leaving device writes an exact
   position for the current track first, so the new device seeks precisely. Ambient resume stays
   lazy (8s); only the handoff moment is exact.

## Open questions
1. **Tier boundary.** The session sits on the host (Tier 1) for one library. When multi-library
   arrives, does "what am I playing" become a Tier-2 per-user object across hosts, or stay
   per-host and the app shows the active one? Flagged so the `session:{ownerId}` addressing
   stays compatible with either.
2. **Does the queue snapshot need trimming?** queue.json holds the whole ordered queue +
   index; proposing the session mirrors it verbatim (simplest). Revisit only if a very large
   queue makes the row heavy.
