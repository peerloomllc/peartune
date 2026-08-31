# Three grant fixes ported from the shared host package

**Goal** - three behaviors PearCinema already fixed in `../peerloom-host` land in PearTune's
host: a dashboard rename stops rewriting what a phone calls itself, a revoked device is told
so once instead of knocking forever, and a grant change reaches a connection that is already
open instead of waiting for a reconnect.

**Tier** - T3 for the goodbye (it changes what the auth gate says to a refused peer) and T2
for the other two (a new persisted field, a new push kind). One proposal because they ship
together as one port and share the rollback story.

## Where this comes from

PearCinema extracted its host core into `../peerloom-host` and fixed all three there, each
with hardware verification (peerloom-host #10, #12, #13; pearcinema #126, #164/#165, #226).
The confirmedUser commit says outright that PearTune has the same overwrite bug. PearTune
does not consume the package, so the fixes are ported by hand into `host/`, keeping
PearTune's own store and server code. Adopting the package wholesale is a separate, larger
decision and is not this proposal.

## Fix 1 - the operator's label is not the device's name (T2)

**The bug, in PearTune today.** `host/grants.js` `renamePerson()` loops every live grant of
that person and rewrites `claimedUser` to the new name. `claimedUser` is the name the DEVICE
declared for itself; the dashboard compares it with the person's name to decide whether a
claim is confirmed. So an operator fixing a typo silently rewrites what somebody's own phone
calls them, in the field the phone set.

**The fix.** Record confirmation instead of deriving it:

- New persisted field on a grant: `confirmedUser` (string or null). Null means "never
  confirmed", which is exactly what every existing row already says, so there is no
  migration and no flag day.
- A pure `confirmedClaim(grant, person)` rule answers "does this claim match this person"
  in one place. The dashboard and the store both use it.
- `renamePerson()` backfills BEFORE renaming: any live grant whose claim matches the OLD
  name gets `confirmedUser = claimedUser` written down, then the person is renamed and no
  grant is touched again. The comparison happens while the old name still exists to compare
  against; afterwards nothing can derive it.
- `settleClaim(deviceKey)`: the dashboard action for the other direction - the device
  renamed itself and the operator wants to accept the new name and leave the device where
  it is. Sets `confirmedUser = claimedUser` on that one grant. This is the case Tim walked
  into on PearCinema: he renamed the TCL from the phone and the dashboard offered nothing
  that worked.
- A grant with `confirmedUser` null falls back to today's name comparison, so behavior on
  existing data is unchanged until a rename or a settle writes the field.

## Fix 2 - say goodbye to a revoked device (T3)

**The bug, in PearTune today.** `_firewall` denies a revoked device at connect time with no
explanation, exactly as it denies a stranger. The phone shows "could not reach the host" and
redials every ~9 seconds forever; the person blames their network. PearCinema watched this
on the TCL and measured six or seven denials a minute.

**Why telling is safe.** Never explaining a refusal is right for a stranger: telling an
attacker why is free intelligence. A device holding a tombstoned grant is not a stranger.
It proved possession of a key this host once granted, so it already knows the library
exists, knows it had access and holds the host key. Saying "not any more" leaks nothing.
`no-grant` stays silent - an unknown key learns nothing, exactly as today.

**The mechanism, ported as is:**

- `host/gate.js` gains `mayBeToldWhy(reason)`: true only for `device-revoked`,
  `person-revoked` and `grant-expired`.
- `_firewall` admits such a device ONCE per key per minute (a rate-limit map capped at 256
  keys, so minted keys cannot grow it without bound). Every other attempt is denied exactly
  as today, so a phone that ignores the goodbye cannot keep the host answering.
- In `_onconnection`, when the media handshake finds no valid grant and a farewell is owed,
  `serveFarewell` opens the media channel with NO method table on it, sends one push
  (`kind: 'access:revoked'`, with the reason), then destroys the connection after 250ms.
  It is a separate function from `serveMedia` on purpose: a `goodbye: true` flag on
  `serveMedia` would be one `if` away from admitting a revoked device to the whole API.
- Worklet (`src/bare.js`): on `access:revoked`, write the verdict TO DISK, stop redialing
  that library and tell the UI. On disk because PearCinema found in-memory forgot it on an
  airplane-mode relaunch. The verdict is cleared by the next dial that lands, because a
  dial landing IS a grant existing - that is also what makes re-pair work without a special
  case. The UI shows it as a standing notice on the library, never as an error line (the
  next successful list of another library wipes error lines).

**The acceptance test changes shape.** Today: the socket does not open. After: one socket
opens, every method on it is refused, the reason is given, the host drops it, and the next
attempt inside the minute is refused outright. Revoke's guarantee is unchanged: nothing NEW
after the cut - the goodbye channel can only say goodbye.

## Fix 3 - a grant change reaches open connections (T2)

**The bug, in PearTune today.** `assign()` (and any other grant edit) writes the store, but
a phone with a live connection keeps its `grant` snapshot until it reconnects - so a device
reassigned mid-song keeps filing resume points and favorites under the old owner for as long
as the connection lives.

**The fix, ported as is:**

- `serveMedia` returns a handle with `setGrant(row)`, which swaps the grant snapshot the
  method table reads. The host remembers handles per device key, pruned on close.
- `assign()` (dashboard and API paths) calls `setGrant` on every live handle for that
  device and pushes `kind: 'grant:changed'` through presence, the same push path
  `devices:changed` already rides.
- Worklet: on `grant:changed`, refresh per-person state (resume, favorites) for that
  library. PearCinema's follow-on lesson applies here: the phone must actually rebuild what
  it derived from the old grant, or the UI keeps drawing a stale picture.

## Compatibility and rollback

- Old phone, new host: `access:revoked` and `grant:changed` are pushes with new kinds; the
  worklet's dispatcher ignores kinds it does not know, so an old app sees today's behavior
  (silence and reconnect-to-refresh). No wire method changes shape.
- New phone, old host: it simply never receives the new kinds. The on-disk revoked verdict
  is only ever written on receipt, so it cannot appear against an old host.
- `confirmedUser` is a new nullable field on rows only this host reads. The grant store is
  host-local and never replicated, so nothing else can see it.
- Rollback: revert the host; the field is ignored by old code, the pushes stop, phones fall
  back to reconnect semantics. The worklet's verdict-clearing rule (any successful dial)
  means a rolled-back host also clears any goodbye a phone recorded.

## Verify

- Unit: `mayBeToldWhy` list is exactly the three reasons; the rate limit admits once per
  key per minute and its map stays capped; `confirmedClaim` truth table;
  `renamePerson` backfills a matching claim and leaves a mismatched one unconfirmed;
  `settleClaim` settles one device only; `setGrant` swaps what the method table reads.
- Hardware, per the canonical smoke: revoke the TCL mid-song from the dashboard - within a
  second reconnect is denied and browse fails, the phone shows the revoked notice once and
  stops knocking, and the notice survives killing and relaunching the app in airplane mode.
  Re-pair the TCL - the notice clears with no extra step. Rename a person on the dashboard
  while their phone is connected - the phone's own name is untouched. Reassign a playing
  device - the next resume point lands under the new person without a reconnect.
