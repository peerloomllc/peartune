# Milestone 3, Phase 1: user state via host-as-hub (favorites first)

## Goal
Give PearTune per-user music state (favorites, then resume positions, play counts,
playlists) that syncs across a person's devices — by storing it on the **host**, which is
already always-on and already the authority for the library and the allow-list. Land the
foundation plus **favorites** as the proving feature; the rest follow on the same rails.

## Tier
T2. New persisted host state and new methods on the existing `peartune/media/1` channel.
No new swarm, no new identity, no multi-writer merge, no wire-framing change. Old peers
degrade via `ENOMETHOD`. (Migration: none — the state store is new and additive.)

## Background: why host-as-hub, not a ledger
Every other PeerLoom app is phone-to-phone, so it needs an Autobase ledger to sync state
between devices with no server in the middle. **PearTune is the one app with a host** — an
always-on machine holding the music and the grants. That host can simply *be* where user
state lives: the phone writes a favorite to the host, the tablet reads it from the host,
and cross-device sync is free because both devices talk to the same host. This drops the
whole ledger subsystem (Autobase, a second swarm, a signing identity, writer admission,
CRDT conflict rules, native-dep alignment) that phone-to-phone apps are forced into.

It is also *safer* here: because the host serializes every write and derives the owner from
the Noise-authenticated connection, the "a device must not write state under another user's
key" threat — the thing that made a ledger T3 — simply cannot arise. There is one writer
(the host), and the client never asserts whose state it is.

## The data tiers (the design that keeps multi-backend open)
User data splits by who naturally OWNS it. Naming the tiers now is what stops us painting
into a corner when a user later connects to several libraries at once (Asa → Tim's Umbrel +
Jim's Mac-Mini, seen as one library):

- **Tier 1 — library-scoped state** (favorites / resume / counts of a library's tracks).
  Owned by that library's HOST. This is what host-as-hub stores. It scales to N backends
  for free: each host independently keeps "this person's state for MY tracks", and the phone
  connects to several and unions the results. THIS PROPOSAL builds Tier 1.
- **Tier 2 — cross-library, per-user objects** (playlists that mix tracks from several
  hosts, a unified listening history, the roster of servers a user connects to). Owned by
  the USER's own devices, because it must reference every host and survive any one going
  away. OUT OF SCOPE here — but the Tier-1 design leaves a clean seam for it (below), and it
  is the one place a small ledger, scoped to a user's OWN devices, may legitimately return.

**The seam:** Tier-1 state is addressed as `(library, trackId)` and the app treats
"my favorites" as *the union of what each connected host reports for me*. With one host
that is one list; adding hosts later is unioning more lists — no change to how a host stores
its own tier-1 state. Cross-library objects are explicitly deferred to Tier 2, not wedged
into a host.

## Scope
**In (Phase 1):**
- **A host state store.** A new Hyperbee (`state`) in the host's existing corestore, kept
  separate from the grant store so grants stay a single-purpose security surface. Rows:
  `fav:{ownerId}:{trackId}` → `{ on: bool, updatedAt }`.
- **The owner is host-derived, never client-asserted.** On each media connection the host
  already knows the Noise-authenticated `deviceKey` and can look up its `personId`. The
  owner is `personId` if the device is assigned to a person, else the `deviceKey` (an
  unclaimed device is its own owner until confirmed). The client says "favorite this track";
  the host stamps who. Nothing to forge — same rule as `identity.set` (proposal 2026-07-14).
- **New media-channel methods** (JSON `{method, params}`, so an old host answers `ENOMETHOD`
  and the app degrades to "favorites need a host update"):
  - `fav.set({ trackId, on })` → upsert the owner's row, LWW on `updatedAt`.
  - `fav.list()` → the owner's favorite trackIds (for overlaying hearts + the Favorites view).
- **The app**: a heart on tracks/albums/rows and a Favorites view, reading `fav.list()` and
  toggling with `fav.set`. A device caches its own `fav.list()` locally so hearts render
  offline (read-through); writes in Phase 1 require a host connection (an offline write-queue
  is a later nicety, and matters only for pinned offline playback).

**Out (follow-on phases, same host-as-hub rails):**
- Phase 2: `resume:{ownerId}:{trackId}` playback position (LWW).
- Phase 3: `count:{ownerId}:{trackId}` play counts. Host-mediated, so a simple increment —
  no per-writer accounting needed (the host serializes). Counts survive revoke (DECISIONS
  2026-07-13: revoke is access control, not a history eraser).
- Phase 4: playlists WITHIN one library (host-owned, ordered array is fine — single writer,
  no CRDT). Cross-library playlists are Tier 2, deferred.
- Phase 5: offline pin + LRU cache of audio bytes on the phone + the offline write-queue.
  `media.stream` already supports offset/length for resumable pinned downloads.

## Compat / migration
- **Purely additive.** New Hyperbee, new methods; the media/pairing wire framing is
  unchanged. A host or app on old code simply has no favorites — an old host answers
  `ENOMETHOD` and a new app says "favorites need a host update"; a new host with an old app
  is never asked. Grants, pairing, revoke, streaming all untouched.
- **No new dependency.** Uses the corestore/Hyperbee the host already runs. No
  `@peerloom/core`, no Autobase, no native-dep alignment, no second swarm.
- **Assigning a device to a person** later moves its owner key from `deviceKey` to
  `personId`. v1: new favorites land under the person; pre-assignment favorites stay under
  the deviceKey (a one-time `state`-migration on confirm is a nice-to-have, flagged below).

## Verify
- **Cross-device sync**: favorite a track on phone A; phone B (same person, same host) shows
  it favorited — because both read the host.
- **Owner is host-derived**: a crafted `fav.set` cannot set another person's favorite; the
  host ignores any client-supplied owner and stamps from the connection (unit test on the
  handler + an on-hardware attempt).
- **Offline display**: airplane-mode after a sync — hearts still render from the local cache.
- **Persistence**: favorite, restart the host, `fav.list()` still returns them (it is in the
  host's Hyperbee, not memory).
- **Transport unregressed**: pair, stream, and **revoke still cuts all NEW access within a
  second** (the CLAUDE.md acceptance test) — user state changes nothing there.
- `npm run verify` green with new unit tests for the state store (owner derivation, LWW,
  toggle-off).

## Rollback
- Additive and independent: the media channel simply stops offering `fav.*` and PearTune is
  today's app. A feature flag gates the state store.
- No migration to reverse; deleting the `state` Hyperbee removes favorites with zero effect
  on grants, identity, pairing, or the media path.

## Open questions
1. **Owner key when a device is unclaimed vs assigned.** Proposing `personId ?? deviceKey`,
   with an optional one-time migration of a device's favorites onto the person when the
   operator confirms a claim. Confirm the migration is worth it or if "favorites start fresh
   under your name once confirmed" is acceptable.
2. **Do library list responses carry fav-state inline, or does the app overlay from
   `fav.list()`?** Leaning overlay (one `fav.list()` call, app joins by trackId) — keeps the
   list endpoints unchanged and avoids per-row cost. Decide when wiring the UI.
3. **Should favorites read offline require a local cache from day one (Phase 1) or is that a
   Phase-5 concern with the rest of offline?** Proposing a minimal read-through cache now
   (cheap, makes hearts feel instant), full offline write-queue in Phase 5.
4. **When Tier 2 arrives**, does the per-user cross-library layer live purely on the phone,
   sync across a user's own devices via a small ledger, or nominate a "home" host? Explicitly
   deferred — flagged so the Tier-1 addressing (`(library, trackId)`, union-at-the-client)
   stays compatible with all three.
