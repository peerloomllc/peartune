# Cross-host session — "Play here" for the merged queue (multi-host phase 3)

## Goal
Extend the deliberate **"Play here"** handoff (proposal 2026-07-17) to the **merged** library. Today
handoff works only for a single-library queue, because the session lives on the one host that owns the
tracks. In merged mode the queue spans hosts — a Mac track, then an Umbrel track — and **no single host
owns it**, so there is nowhere to put "what this person is playing across all their libraries." This is
the Tier-2 cross-host session that 2026-07-17 explicitly flagged and deferred (its open question #1).

Move an in-progress *mixed-host* session — same blended queue, same track, same spot — from one of your
devices to another, exactly as single-library handoff already does.

## Tier
**T3** (it's the "hard one" the merged-library proposal named). It introduces a **cross-host session
authority** (a new coordination primitive) and a session row that carries **foreign trackIds** from
other hosts. It does **not** touch the wire framing, the grant store, or the revoke guarantee — each
host still authorizes this device independently, the session is still gated by a host's grant, and a
revoke still denies session read/claim on that host within a second. The blast radius is handoff
*correctness* across hosts (electing the right authority, rebuilding a mixed-host queue, not losing the
token to a race), which is why it gets phases and a proposal rather than riding in.

## Why single-library handoff doesn't just work merged
2026-07-17's session is `session:{ownerId}` on **the host that owns the tracks**, arbitrated by a
monotonic `generation` CAS **on that one host**. Two facts break that for the blend:

1. **The queue spans hosts.** A merged queue's items carry `{trackId, libraryId, copies, …}` (step-2
   slice 4). No single host holds all those tracks, so no single host is the natural home for the row.
2. **The CAS needs ONE authority.** If we mirrored the session onto every host and let each arbitrate
   its own `generation`, two devices could each "win" a claim on different hosts at the same instant —
   the exact tug-of-war the whole design exists to prevent. A single compare-and-set point is
   non-negotiable for a conflict-free token.

## Design — elect one deterministic "session home" host
The merged session lives on **one** of the person's paired hosts, chosen the same way by every device
so they all coordinate through the same CAS:

- **Election:** the connected paired host with the lexicographically-smallest `hostKey`. Deterministic
  (no negotiation, no clock), stable while the set of hosts is stable, and every device computes it
  identically from `hosts.json`. That host is the **session home**; all merged-session ops go to it.
- **The row:** `session:merged:{ownerId}` on the home host's existing `state` Hyperbee — a distinct key
  from the per-library `session:{ownerId}`, so a host can be BOTH someone's single-library session home
  and the merged home without collision. Shape mirrors 2026-07-17 plus the routing tags each merged
  queue item already carries:
  ```
  { queue: [{ trackId, libraryId, copies, ...renderMeta }],
    index, shuffle, repeat, activeDeviceKey, generation, updatedAt }
  ```
  IDs + render metadata + routing tags only — **never shim URLs** (ports change per launch; the
  receiver re-resolves via `urlFor`, which already routes each item to its owning host — slice 4).
- **The methods** (new, on the existing `peartune/media/1` channel; old host → `ENOMETHOD`): the same
  three as 2026-07-17 with a `merged: true` scope, so the home host reads/writes the `merged` row and
  applies the identical `generation` CAS: `session.get`, `session.claim`, `session.set`. `ownerId` is
  host-derived (`personId ?? deviceKey`) on the home host, never client-asserted — and the deviceKey is
  the SAME identity on every host, so a device presenting itself resolves to the same owner it claimed
  under. The home host stores the foreign trackIds **opaquely** (they're metadata to it; it never
  dereferences them).

### The app
- The merged queue already persists to `lib/_merged/queue.json` (slice 4). Playing/continuing a merged
  session **claims** the home host's `merged` session; thereafter queue changes push `session.set`
  (throttled — the same `persistQueue` cadence that already writes `queue.json`, which also mirrors to
  the single-library session today).
- A non-active device shows the existing **"Playing on <device>"** card with **"Play here."** Tapping
  it: `session.claim` on the home host → rebuild the **merged** ExoPlayer queue from the row (each item
  routed to its owning host by `urlFor`), seek the current track to its resume position (which now
  routes to that track's owning host — phase 2, #96), and play. The previously-active device pauses.
- **One-shot exact resume flush on handoff** (2026-07-17 move #3), now routed to the leaving track's
  owning host, so the receiver seeks precisely despite 8s-granular ambient resume.

## Reuse (why this is mostly wiring)
Every hard part already exists: mixed-host queue items with routing tags (slice 4), `urlFor` per-track
routing (slice 4), per-track resume routing (#96), the queue-restore path (PR #29 / slice 4's
`lib/_merged/queue.json`), and the whole single-host session/CAS/"Play here" machinery (2026-07-17). This
proposal is: **point that restore path at the elected home host's `merged` row instead of the local
file, and add the election.** The election is the only genuinely new primitive.

## Scope
**In:** the election, the `session:merged:{ownerId}` row + the three `merged`-scoped methods, the app's
claim-on-play / push-on-change / "Play here" for the blended queue, and the routed one-shot resume flush.

**Out (v1, all deferrable on the same rails):**
- **Home-host offline → no cross-host handoff.** If the elected home is unreachable, the "Play here"
  card hides (or shows "session unavailable"); the **local** merged queue keeps playing from
  `queue.json`, and single-library "Play here" against a reachable host is unaffected. The session
  resumes when the home returns. (Mirroring the row to a backup host is a later nicety.)
- **Re-election churn.** Removing/unpairing the home host re-elects the next-smallest `hostKey`; the
  session does **not** carry across the change (v1 accepts a reset — same spirit as favorites' "start
  fresh under your name once confirmed"). Adding a new *smaller*-keyed host mid-session likewise doesn't
  migrate an in-flight session; it takes effect on the next claim.
- **Continuous position streaming / instant presence / mirroring / casting** — unchanged from
  2026-07-17's deferrals.

## Compat / migration
- **Purely additive.** New row family (`session:merged:*`) in the existing `state` Hyperbee, new
  `merged` scope on existing methods; framing unchanged. Old host → `ENOMETHOD` → no merged "Play here"
  card, local blended queue behaves as today. Single-library sessions (2026-07-17) are untouched and
  remain the path when merged mode is off.
- **No new dependency, no new swarm.** Same corestore/Hyperbee, same channel, same pool connection the
  merged index already uses to reach every host.

## Security review
- **Revoke unchanged and still per-host + instant.** The merged session is gated by the **home host's**
  grant: revoke this device on the home host → its `session.get/claim/set` are denied within a second
  with all other NEW access to that host; it cannot resurrect a session (nor past the offline lease).
  Its local queue may finish its buffer (the deliberate graceful-reconnect stance), but nothing NEW.
  Other hosts' tracks in the mixed queue keep streaming — the per-host guarantee, in a mixed session.
- **Owner is host-derived, cross-host-consistent.** The home host stamps `ownerId` from the
  Noise-authenticated connection; a crafted `session.set/claim` can't touch another person's session.
  The device key is one identity across hosts, so the owner a device claims under is the owner it reads
  under.
- **No new access surface, no bearer token.** Still pure per-host Noise auth; the election is a local
  computation over already-known host keys, not a granted capability.

## Verify
- **Merged handoff:** build a mixed-host queue on phone A (a Mac track and an Umbrel track), play, skip
  to the foreign-host track, seek. Open phone B (same person) → "Playing on A." **Play here** → B
  rebuilds the blended queue at the right track/position, each track streams from its owning host, and A
  pauses.
- **Single CAS authority:** two `session.claim` racing on the same `generation` at the home host → exactly
  one wins (unit test on the CAS), the loser is told it's stale. With B active, a queue edit on A does
  not overwrite the session.
- **Deterministic election:** every device picks the same home host from the same `hosts.json`; a unit
  test over host-key sets.
- **Home offline degrade:** take the home host down → no merged "Play here" card, local blended queue
  keeps playing; bring it back → handoff works again.
- **Revoke (CLAUDE.md acceptance):** revoke B on the home host mid-handoff → its session ops denied within
  a second; the other hosts' tracks in the queue are unaffected.
- `npm run verify` green with new unit tests for the election and the merged CAS/owner derivation.

## Rollback
Additive and feature-flagged: the media channel stops offering the `merged` session scope, the app hides
the merged "Play here" card, and PearTune is today's blended-queue-per-device app. Deleting the
`session:merged:*` rows removes cross-host handoff with zero effect on grants, identity, pairing, the
media path, the single-library session, or the local queue.

## Resolved (Tim, 2026-07-20)
1. **Home offline → DEGRADE, no mirror.** If the elected home host is unreachable, the merged "Play here"
   card hides and the local blended queue keeps playing from `queue.json`; handoff resumes when the home
   returns. One write path, one CAS authority — a mirror to a backup host (and its two-row reconciliation)
   is a deferred v2 nicety, not v1.
2. **Election = smallest `hostKey`, DETERMINISTIC.** Every device computes the same home from the same
   `hosts.json`, which is what lets a single CAS authority work. Preferring the device's *active* host was
   rejected: different devices have different active hosts, so they'd disagree on the home and race two CAS
   authorities — the exact tug-of-war the design exists to prevent. Determinism wins over availability here.
3. **Owner = `personId ?? deviceKey` on the home host** (the single-library rule). Handoff is between a
   *person's* devices, so the session must be keyed by the thing that groups them (`personId`) — keying by
   the per-device `deviceKey` would give each device its own row and no handoff at all. Because the session
   lives on exactly **one** elected home host, only that host's derivation matters, so there is no cross-host
   drift for a stable home; both of a person's devices reaching that home resolve to the same `personId`.
   The one edge case — **re-election** to a different home (the old home was removed/unpaired) — resets the
   session (v1 accepts it, matching favorites' "start fresh once confirmed"); a carry-across is deferred.

## Still open (for v2, not blocking)
- The exact card copy + behavior when the home is offline mid-session ("session unavailable" vs. silent
  local fallback), and whether a re-election reset warrants any user notice.
- A backup-host mirror (resolved-1's deferral) if home-host uptime proves too fragile in practice.
