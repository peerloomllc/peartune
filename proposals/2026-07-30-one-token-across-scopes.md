# One play token per person, across both session scopes

**Goal** - a device in the blended library view and one focused on a single library can no longer
both be "the active player" at the same time.

**Tier** - T1 shading into T2. No new fields, no new methods, no wire change; what changes is which
stored row a successful claim writes. Recorded as a proposal anyway because it is cross-device
arbitration, and the last one of those (2026-07-17) earned its write-up.

## Why

Found while diagnosing Tim's "two devices play at once" report (PR #272) and left open because it
was not what he hit. `host/state.js` keys the play session as `session:{ownerId}` for a
single-library device and `session:merged:{ownerId}` for one in the blend. Two rows, each with its
own `activeDeviceKey` and `generation`, and a compare-and-set on one is invisible to the other - so
a phone in the blended view and a phone focused on one library can each hold "the" token and both
play, for as long as they like. Nothing odd is required to get there: merged mode turns itself on
at 2+ paired libraries, so the two phones only need different pairing sets.

The separate rows are deliberate and stay. One host can be BOTH a person's single-library session
home and the elected merged home, and the queues mean different things in each: a merged queue
carries foreign trackIds tagged with their owning library, a single-library queue carries local
ones. Collapsing them would break "Play here" across scopes, which is a worse bug than the one
being fixed.

## Scope

Separate the two things the row conflates. **The queue is per-scope; the token is per-person.**

A successful `session.claim` in one scope also takes the OTHER scope's row for the claiming device:
`activeDeviceKey` moves, `generation` bumps, and the queue/index/position/shuffle/repeat of that
row are left exactly as they were. So:

- the previous holder of the other scope gets the same `session-superseded` push the same-scope
  loser already gets, and stops instantly;
- if it misses the push, its next `session.set` is refused - `setSession` gates on
  `activeDeviceKey`, which no longer names it - so the existing lazy path stops it too;
- "Play here" from either scope still works, because each row kept its own queue.

`session.get` is untouched: a device still reads its own scope, and `isActiveHere` now answers
honestly for a person rather than for a scope.

**Not in scope.** Merging the rows, electing one scope per person, or teaching the client to read
both. All three were considered; see below.

## Compat

- No schema change. Same fields, same keys, same methods.
- OLD host, new client: no cross-scope supersede, which is exactly today's behavior. Not a
  regression, just the bug staying fixed only on updated hosts.
- OLD client, new host: it is superseded by a push and a refused write, both of which it has
  understood since 2026-07-17. Nothing to teach it.
- A person who has only ever used one scope has one row and never notices; taking a row that does
  not exist yet creates an empty one, which is what a first claim already does.

## Verify

- Unit: claiming the merged scope moves the single-scope row's `activeDeviceKey` and bumps its
  generation, and leaves that row's queue untouched. And the reverse.
- Unit: the claiming device holding both rows means the other scope's previous holder is refused
  by `setSession`.
- Integration, two devices one person against a real host: A claims single, B claims merged, A
  receives `session-superseded` and its next write is refused.
- NOT verified on hardware. It needs one phone paired to two libraries and one to a single
  library, which is a rig neither of Tim's phones is currently in.

## Rollback

Revert. The rows go back to being independent and the two-scope overlap returns. Nothing persists
that a reverted host would misread - the fields are unchanged, and a row whose token was moved
cross-scope is indistinguishable from one claimed normally.

## Open questions

- Should the cross-scope take also copy `playing: false` onto the other row? It currently leaves
  `playing` as it was, which briefly leaves a row saying "playing" under a device that is not.
  Nothing reads it in that window except the reconcile's liveness check, which is looking at its
  OWN scope, and the next heartbeat from the new holder corrects it. Left alone rather than
  guessed at.
