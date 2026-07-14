# Device and user naming

**Goal** - a device can name itself and say who it belongs to, so the operator's
dashboard shows "Tim's Pixel - Tim" instead of two identical rows called "Android
phone", and per-person revoke becomes usable by a human.

**Tier** - **T2.** New persisted fields on the grant row, two new methods on the
media API. No framing change (see Scope), so an old peer and a new peer still talk.

One part of it is arguably T3 and is called out below: it lets a CLIENT write into
the host's grant store, which is the one store this app says is host-local
authority. The rules that keep that safe are the substance of this proposal.

---

## Why now

Tim paired a second phone. The dashboard shows two rows called "Android phone",
distinguishable only by z32 key. Per-person grants exist and work - assign devices
to a person, revoke the person, every device of theirs dies - but the operator has
nothing human to look at, so the feature is technically complete and practically
unusable.

## What already exists (and why this is smaller than it looks)

- `deviceHello` **already carries a `label` string** (`protocol/framing.js`), the
  host already stores it as `grant.label`, and the dashboard already renders it.
  The app simply hardcodes `'Android phone'` (`src/bare.js`, `pair()`).
  **Naming a device AT PAIR TIME needs no wire change and no new field.**
- The host **already has a people model**: `person:{id}` rows, `assign(deviceKey,
  personId)`, `revokePerson()`. What is missing is any way for the PHONE to say who
  it belongs to.

So the new surface is small: renaming after pairing, and a user claim.

## Scope

### Wire

**No framing change.** `deviceHello` is untouched. Adding a field to it would break
old peers (compact-encoding is positional), which is the difference between T2 and
T3, and it is not needed:

- **At pair time**: the app sends a real name in the EXISTING `label` field.
- **After pairing**: two new methods on the media channel, which carries
  `{ method, params }` JSON already, so adding methods is additive:
  - `identity.get()` -> `{ deviceName, user: { name, confirmed } }`
  - `identity.set({ deviceName, userName })` -> `{ ok, deviceName, user }`

An old host answers an unknown method with the typed `ENOMETHOD` error we already
have, so a new app on an old host degrades to "renaming is not supported here"
rather than breaking.

### Grant row (new persisted fields)

```
grant:{deviceKey} -> {
  deviceKey, personId, label, platform, scope, grantedAt, revokedAt,   // today
  claimedUser,        // NEW: the name the DEVICE says it belongs to, or null
  claimedAt           // NEW: when it said so
}
```

`claimedUser` is a CLAIM, not an assignment. `personId` remains the only thing that
grants or revokes anything, and only the operator sets it.

### The rules that make a client-writable field safe

This is the part that matters. A paired device may now write into the host's grant
store, so:

1. **A device may only ever write its OWN row.** `identity.set` takes no device
   key: the host uses the Noise-authenticated `remotePublicKey` of the connection.
   There is no parameter to forge.
2. **A device may NOT set `personId`.** It may only CLAIM a name. Turning a claim
   into an assignment is an operator action in the dashboard ("Tim's Pixel claims
   to be Tim [Confirm]"), which creates or joins the person.
   Rationale: today `personId` only affects revoke-by-person, so self-assignment
   would be harmless - but the moment per-person scopes, playlists or listening
   history exist, a device that can attach itself to any person by name is a
   privilege escalation. Self-declared identity must not become authority.
3. **A claim grants nothing.** It is cosmetic until confirmed. Revocation, scopes
   and the gate are untouched.
4. **Names are sanitized at the host**: trimmed, max 64 chars, control characters
   stripped. The host is the authority; it does not trust the phone to be polite.
5. **A revoked device cannot claim anything.** It has no live media channel, so
   this is already true - it is asserted in a test so it stays true.

### The security bug this uncovered (fix included here)

`host/ui/page.js` interpolates `d.label` **raw into `innerHTML`**, and `label`
arrives from `deviceHello` - i.e. from any device that reaches the pairing window.
That is a **stored XSS on the operator's dashboard**, which is the page holding the
revoke buttons and the pairing QR.

It exists TODAY, before any of this work, and naming makes it worse (people will
type names, and rename later). This proposal fixes it: every device- or
operator-supplied string is HTML-escaped at render (`label`, `claimedUser`, person
`name`), and the `revoke(...)` onclick argument stops carrying a user string
altogether - it takes the device key, and the confirm text is looked up from data.

## Compat

| | Old host | New host |
|---|---|---|
| **Old app** | today's behaviour | sends `label: 'Android phone'`; `claimedUser` is null; dashboard shows the label as before |
| **New app** | pairs and names the device (label is already on the wire); `identity.set` fails with `ENOMETHOD`, the app says renaming needs a server update | full feature |

Grant rows written before this change have no `claimedUser`; it reads as `null`. No
migration.

## Verify

Unit (host):
- `identity.set` writes only the calling device's row; there is no key parameter to
  pass, and a second device's row is untouched.
- a claim never sets `personId`.
- `confirm` (operator) creates the person if new, joins if existing, and refuses a
  revoked person (the existing `assign` rule).
- names are trimmed / capped / stripped of control chars.
- **dashboard renders `<script>` in a label as text, not as a script.**

On-device (TCL + Pixel + Umbrel):
1. Pair the TCL with the name "Tim's TCL". Dashboard shows that row, not "Android
   phone".
2. Rename it in Settings to "Test phone". Dashboard updates.
3. Claim the user "Tim" on both phones. Dashboard shows both claims.
4. Confirm the claim -> a person appears with both devices under them.
5. Revoke the PERSON -> both phones lose access mid-song.

## Rollback

Revert the branch. The new grant fields are additive and ignored by the old code;
`identity.*` simply stops being answered, and the app already handles `ENOMETHOD`.

## Open question (deliberately not decided here)

Should an unconfirmed claim be shown to the operator at all, or should the phone
stay anonymous until the operator names it? Showing the claim is friendlier and is
what this proposes; the cost is that a stranger who pairs can put a chosen string
on the operator's screen - now safe to RENDER (see the XSS fix), but still a small
social-engineering surface ("Tim's Pixel" claimed by someone who is not Tim). The
mitigation is that a claim grants nothing and the operator must confirm it.
