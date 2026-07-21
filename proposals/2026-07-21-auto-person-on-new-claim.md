# Auto-create a person on a NEW claim; still confirm to join an EXISTING one

**Goal** — a device that claims a user name no person yet holds is assigned to a fresh person of
that name automatically, so a first device (or a re-pair after the person was deleted) doesn't need
an operator click; a device claiming a name that already exists still stays pending until the
operator confirms the join.

**Tier** — T3 (refines the identity/authority rule in proposals/2026-07-14-device-and-user-naming).

## Problem

Today `confirmClaim` already does the right thing — `personByName(claim) || addPerson(claim)` then
`assign` — but only when the operator clicks confirm. So a device that names itself "Tim" sits
`personId: null` (unassigned) until then. Re-pairing a device after its person was deleted lands
unassigned too: the claim is set, but nothing recreates + assigns the person without a manual click.
For the trivial first-device case that click adds nothing the operator hasn't already decided by
opening the pairing window.

## The rule change

2026-07-14 says: *"a device may name itself but may never set its own personId."* We refine it to:

> **A device may create a NEW person for itself, but may never assign itself to an EXISTING one.**

The invariant that actually protects anyone is preserved: a device can never attach itself to a
*pre-existing* identity (and inherit its grant, shared favorites/resume/session, or operator trust).
A brand-new person created from a self-declared name inherits nothing — it is an empty, single-device
person, functionally identical to today's "an unassigned device is its own state owner." And the
device was already admitted by the operator opening the pairing window.

## Scope

**Changes** — `grants.setIdentity` (the only place a device declares its own claim, over the media
channel): when `userName` is set AND the device is currently **unassigned** (`personId` null) AND
`personByName` finds **no** person of that name, create that person and assign this device to it.

**Does NOT change:**
- **Joining an existing person.** If a person of the claimed name exists, `personId` stays null — a
  pending claim the operator confirms exactly as today. This is the higher-risk path and it keeps its
  checkpoint.
- **Already-assigned devices.** If the device already has a `personId`, a later claim change follows
  the existing pending/confirm flow (a rename is a new claim; the operator re-confirms). We never
  auto-*reassign*.
- The operator dashboard, `confirmClaim`, `assign`, revoke/leave — all untouched. The auto-assign
  produces exactly the same shape a confirm would.

## Compat

Host-only, no wire change. Old clients pair and `identity.set` exactly as before; the host just
assigns a new-name claim instead of leaving it pending. Nothing to migrate. An old host (no auto-
assign) simply leaves the claim pending — today's behavior — so a mixed fleet degrades to "click to
confirm", never to a wrong assignment.

## Verify

`npm run verify` (grants unit tests: a new-name claim on an unassigned device auto-creates + assigns
the person; a claim matching an EXISTING person stays pending, `personId` null; an already-assigned
device is not silently reassigned; a blank/cleared claim assigns nobody). Then on-device: pair a
phone, name yourself a NEW name → it appears already grouped under that person on the dashboard; pair
a SECOND phone claiming the SAME name → it lands pending "Claims <name>", confirmed with one tap.

## Rollback

Revert the `setIdentity` change. Claims go back to pending-until-confirmed; the persons already
auto-created stay valid (same shape as an operator-created one).

## Open questions

- **Second-checkpoint loss for new names.** A stranger admitted through an open pairing window
  claiming a *new* name now becomes that person with no confirm step. Root protection stays the
  pairing window (deliberate admission). If an operator wants the strict two-checkpoint flow back, a
  host toggle ("auto-create people on pair", default on) is a small follow-up — deferred unless
  wanted.
- **Simultaneous identical new claims.** Two devices claiming the exact same brand-new name within
  the same instant could both pass `personByName` (null) and create two persons — the same race
  `confirmClaim` already has. Acceptable; the operator can merge via rename.
