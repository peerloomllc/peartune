# The requester closes the ask

**Goal** - an answered music request stops being pending on every OTHER library it was
filed with, without hosts ever talking to each other. Ported from PearCinema's proposal
2026-08-22 (the shape was Tim's call there: the requesting device coordinates), adapted
to PearTune's request plumbing.

**Tier** - T3. It moves an auth gate: `owner.requestResolve` is owner-only today, and
this lets the person who FILED a row resolve their own copy of it - a change to who may
write what on somebody else's host. Everything else about it is small.

## What is wrong

A request is filed with EVERY reachable host on purpose - none of them has the music, so
any of their owners might add it (`src/bare.js` `requestAdd` fans out in merged mode,
and `collapseRequests` folds the per-host rows back into one ask).

Resolving is where the symmetry stops. `owner.requestResolve` writes the row on the host
it was called on and notifies exactly one party: the requester
(`resolveRequestAndNotify` -> `request:resolved`). The sibling hosts holding their own
copy are never told, so their owners keep seeing a pending ask that is already answered,
and a second owner can add music somebody already added.

It is only closed everywhere when a PHONE owner does it: the worklet's
`ownerResolveRequest` fans out across `merge.resolveTargets`. But that fan-out reaches
only libraries the RESOLVER owns - and two different owners on two machines is exactly
the case the app is built for, so a dashboard resolve (or a resolve by an owner who owns
only their own box) leaves every sibling copy pending forever.

## The shape

The requesting device coordinates, because it is the only party that knows every copy of
the ask exists - it already holds them as `refs` (each `{ libraryId, id, status }`),
which is what lets REMOVE delete an ask everywhere today.

1. A host resolves. It pushes `request:resolved` to the requester exactly as now - no
   protocol change, no new event.
2. The requester's device notices one copy of its ask says `added` while others still
   say `pending`, and closes the pending copies as `added`, fire and forget.
3. It HEALS rather than fires once: the same check runs whenever the requester lists
   their own requests, so a device asleep when the answer came settles it on next open.
   The `request:resolved` push already makes the open view re-list, so the immediate
   case is covered by the reload that happens anyway.

### Why the auth gate has to move

Step 2 is a write to a host where the requester may be a guest, and
`owner.requestResolve` refuses anyone whose grant is not owner-scope. The rule becomes:
the library's owner may resolve any row, and **the person who filed a row may resolve
that row**. The requester is identified the way it always is - `ownerOf(grant)` from the
Noise-authenticated connection compared to `row.requester` - the exact test
`request.delete` already uses to let a requester make their ask VANISH from the owner's
queue. Marking it answered is strictly less power than deleting it.

### Only `added` travels

A decline is one owner's answer about their own library, not everybody's: a `declined`
on host A leaves host B pending, so another owner may still add it.
`merge.resolveTargets` already refuses to rewrite a non-pending copy; this is the same
rule from the other end. Said out loud: declining from a dashboard still happens per
library; a phone owner who owns all the libraries fans out both verdicts, unchanged.

## Scope

- `host/media.js` `owner.requestResolve`: fetch the row first; admit owner scope OR
  `row.requester === ownerOf(grant)`.
- `worklet/merge.js`: a pure `answeredElsewhere(collapsedRows)` - the pending refs of
  rows that are `added` somewhere - so the decision is unit-testable without a host.
- `src/bare.js` `requestList` (merged branch): fire-and-forget close of what
  `answeredElsewhere` names, then collapse and answer as before. Errors swallowed.
- NOT the store, NOT a new field, NOT host-to-host (host A never learns host B exists),
  NOT the dashboard's own queue (it keeps showing that host's rows).

## Compat

An old host refuses the requester's close with `owner only`; the phone swallows it and
that host stays pending - a mixed fleet degrades to today's bug, not to an error. A new
host with an old phone is unchanged: nothing calls the relaxed path. Nothing stored
changes shape.

## Verify

Unit: `answeredElsewhere` truth table (added+pending closes the pending refs; declined
does not travel; all-pending closes nothing; a row with no refs closes nothing). Host:
the requester may resolve their own row and only their own (a stranger's id is refused);
owner behaviour unchanged. Integration over the DHT testnet: two hosts, one ask filed
with both, owner of host A resolves `added` on A only; the requester's next `requestList`
closes B's copy, and B's owner queue shows it resolved - while a `declined` on A leaves
B pending. Emulator against two local hosts if practical, else the testnet stands.

## Rollback

Revert the host and the gate is owner-only again; the phone's close attempts are
refused and swallowed - today's behaviour. Nothing to migrate.
