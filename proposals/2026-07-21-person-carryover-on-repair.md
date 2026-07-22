# Carry a person over when a device that LEFT BY ITSELF pairs again

**Goal** — a phone that removed a library and later pairs back to the same host returns to the person
it already belonged to, instead of arriving as a stranger and leaving that person holding zero
devices. An operator revoke must NOT carry over.

**Tier** — T3 (unpair semantics + who a device belongs to, refining
`proposals/2026-07-20-client-self-leave.md` and `proposals/2026-07-21-auto-person-on-new-claim.md`).

## Problem

`grants.revoke` tombstones the row and `pair.js` mints a **fresh** grant for any device whose existing
row is revoked:

```js
const existing = await this.grants.get(remoteKey)
if (existing && !existing.revokedAt) { /* idempotent re-pair, personId untouched */ }
else await this.grants.grant({ deviceKey: remoteKey, ... })   // personId: null
```

So every remove-and-pair-again cycle produces an unassigned device and an **orphan person**: a row
holding no devices. Observed live twice this month - removing the Mac library from the TCL left person
"Timmy" empty, and the Mac host already carried an orphan "Tim2" from an earlier cycle.

Two costs, and the second is the one that matters:

1. **Silent accumulation.** People pile up on the dashboard holding nothing. Cosmetic; deleting them
   already works.
2. **User state is stranded.** Since milestone 3 the host is the hub: favorites, resume positions,
   play counts and playlists are keyed by **owner**, and for an assigned device the owner is its
   *person*. A device that comes back as unassigned therefore reads an empty library-of-one - its
   own history is still on the host, under a person nothing points at any more. Re-pairing looks
   like data loss, and "just claim the name again" does NOT fix it: claiming a name a person already
   holds correctly stays pending until the operator confirms (2026-07-21).

## The rule

> **A device that revoked ITSELF, and pairs again through an operator-opened window, returns to the
> person it held at the moment it left. Any other revocation starts it as a stranger.**

This is deliberately narrower than "restore the person on re-pair". It restores only what the device
gave up voluntarily, and only for the same Noise-authenticated key.

## Scope

**Changes:**

- `grants.revoke(deviceKey, { by })` records **`revokedBy`** on the tombstone: `'self'` from
  `leaveDevice` (the `device.leave` path), `'operator'` from `revokeDevice`, `'person'` from
  `revokePerson`. Default `'operator'` - so anything that forgets to say fails to the strict side.
- `pair.js`, on the mint path, carries `personId` (and `claimedUser` / `claimedAt`) over from the
  revoked row **only if all of**:
  - `existing.revokedBy === 'self'`, and
  - `existing.personId` is set, and
  - that person still exists and is not revoked.

  Otherwise the fresh grant is unassigned exactly as today.
- Logged as its own event (`pair:person-restored`, with the person id and name) - a re-pair that
  restores an identity must be visible in the host log, not inferred from a diff.

**Does NOT change:**

- **Operator revokes.** A device the operator threw out comes back as a stranger and needs the
  claim/confirm flow. That checkpoint is the whole point of revoke.
- **`revokePerson`.** The person is revoked; there is nothing to return to.
- **Expired guest grants.** No tombstone is written by expiry (the gate simply denies), so a guest
  re-pairing lands on the existing-row path and keeps whatever it had - unchanged by this proposal.
- **The idempotent re-pair path** (a LIVE grant re-scanning the QR) - already keeps personId.
- **Orphan people that already exist.** They stay until deleted on the dashboard. This stops the
  mechanism producing new ones; it does not clean up history.
- **The grant store's placement.** Still host-local, still never replicated.

## Security analysis

The question is whether this hands identity back to anyone the operator did not admit.

- **The key is proof.** The carried-over row is keyed by the same device public key, and HyperDHT's
  Noise handshake authenticates it. Only the holder of that secret key can present it, so this cannot
  be another device wearing the name.
- **A window is still required.** A revoked device is denied by the firewall; the ONLY way to reach
  the mint path at all is an operator opening a pairing window and the device presenting that
  window's one-time `rv`. The operator's deliberate admission remains the root protection, exactly as
  it is for a first pair.
- **Revoke keeps its teeth.** `revokedBy: 'operator'` never carries over, so "throw this phone out"
  is unchanged: it comes back unassigned and pending. Same for a revoked person.
- **What it does cost.** For the self-leave case the operator loses one confirmation click they get
  today - a phone that left and returns rejoins its person without being re-confirmed. That click is
  a *re*-confirmation of a decision the operator already made, for a key they already trusted, on a
  connection they just admitted. Accepted, and made visible by the log line + the dashboard row.
- **Stale pointer.** If the person was deleted or revoked while the device was away, the checks fail
  and the device arrives unassigned. Nothing can point at a person that is not there.

## Compat

Host-only, no wire change; old and new clients pair identically. `revokedBy` is a new persisted
field, so **existing tombstones have it undefined** - which is not `'self'`, so they never carry over.
Every grant written before this ships behaves exactly as it does today; the new behaviour only
applies to leaves recorded after the upgrade. An old host paired by a new client is unaffected (there
is nothing on the wire to be old about).

## Verify

`npm run verify`, with unit tests in `test/grants.test.js` covering:

- a self-leave then re-pair restores `personId` (and the claim), logged;
- an **operator** revoke then re-pair does NOT - `personId` null, claim pending;
- `revokePerson` then re-pair does NOT;
- a self-leave whose person was DELETED meanwhile does NOT (and does not throw);
- a self-leave whose person was REVOKED meanwhile does NOT;
- a tombstone with no `revokedBy` (pre-upgrade row) does NOT.

Then on hardware, TCL vs the Umbrel: favourite a few tracks, remove the library on the phone, pair
again through a fresh window - the device shows under the same person on the dashboard and the
favourites are back, with no operator confirm. Repeat with an operator revoke: the device returns
unassigned and pending.

## Rollback

Revert the `pair.js` branch. `revokedBy` stays on the tombstones as inert data (nothing else reads
it), so there is no migration either way and no state to unwind.

## Open questions

- **Should the dashboard offer to delete a person the moment it loses its last device?** That is the
  other half of the orphan story (the accumulation half) and is a separate, T0 dashboard change. Not
  included here: deleting is destructive of that person's user state, and with carry-over in place an
  emptied person is often about to be re-filled by the same phone coming back.
- **Should a device leaving keep its state at all?** Today `device.leave` revokes the grant but leaves
  the user state under the person untouched, which is what makes the return valuable. If "remove
  library" should mean "forget me entirely", that is a different proposal - and one that would want
  an explicit "delete my data" affordance rather than a silent side effect of unpairing.
