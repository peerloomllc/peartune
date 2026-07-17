# Guest grants (time-limited access)

**Goal** — let the operator hand out a *temporary* pass: a device that pairs
through a "guest" window gets access that expires on its own after a chosen
duration, with no need to remember to revoke it.

**Tier** — **T2.** It sets a persisted value the auth gate already reads
(`grant.expiresAt`) and adds one new piece of live enforcement (cut connections
at expiry). It does NOT change the wire, the grant-store location (still
host-local, never replicated), or the revoke guarantee. The reserved-null field
means it is a value change, not a schema migration — as the grant-store header
always intended.

Scope for this MVP (confirmed with Tim): **time-limited only.** Library-subset
scopes (the reserved `paths`) are deliberately out — they are a much larger
per-request enforcement job across browse/stream/art, and belong in their own
proposal. Creation flow: **a guest pairing window with a duration** (not editing
expiry on existing devices — that can come later).

---

## What already exists (so this is small)

- `grant:` rows reserve `expiresAt: null` and `paths: null` for exactly this.
- `gate.decide()` **already** denies an expired grant at connect time:
  `if (grant.expiresAt && now > grant.expiresAt) return { allow:false, reason:'grant-expired' }`.
- Pairing (`pair.js`) already mints a grant when the operator has a window open;
  the window IS the operator's consent.
- `Connections.kill(deviceKey)` already destroys a device's live connections
  (built for revoke).

So the only genuinely new behaviour is: **choose a duration when opening a
window**, **stamp `expiresAt` on the grant it mints**, and **cut a guest's live
connection when its grant expires** (because the gate only runs at connect).

## Design

### 1. A guest pairing window carries a duration

`PairSession` gains an optional `expiresMs` (the operator's chosen duration).
The dashboard's pair-start gains a "Guest pass" mode with a duration picker
(presets: 1 day / 7 days / 30 days, plus a custom hours field). A normal
(non-guest) window keeps `expiresMs = null` and mints full, non-expiring grants
exactly as today.

The duration is **operator-set, host-side.** It is never read from the device's
`hello` — a guest must not be able to choose its own expiry. This mirrors the
existing rule "a device may name itself but may not set its own personId".

### 2. Pairing stamps `expiresAt`

`grants.grant()` takes an `expiresAt` param (default `null`). When a device pairs
through a guest window, `pair.js` passes `expiresAt = Date.now() + expiresMs` and
`grantedBy: 'qr-guest'`. Everything else about the grant is identical to a normal
pair.

Re-pairing an already-granted device through a guest window **refreshes** its
expiry (same idempotent path that already updates a label), so "extend the pass"
is just "scan again while a guest window is open". A full window leaves the expiry
alone, so re-pairing a permanent device never accidentally time-limits it.
(Promoting a guest to permanent is a follow-up, under dashboard expiry editing.)

### 3. Expiry cuts live connections (the new enforcement)

`gate.decide()` covers *connect*. But a guest connected five minutes before
expiry would keep streaming until it happened to reconnect — the same gap revoke
has, and the reason `Connections` exists. Time-based expiry has no event to hang a
`kill()` on, so the host runs a **periodic sweep** (every 30 s): for each device
with a live connection, load its grant and, if `decide()` now refuses it
(expired), `connections.kill(deviceKey)`. Bounded lag ≤ 30 s.

Why a sweep and not a per-grant `setTimeout`: it is restart-safe (a timer is lost
on restart; a sweep just runs again), it needs no bookkeeping when grants are
added/removed, and 30 s is fine for a *scheduled* expiry — this is not the
security-urgent, sub-second claw-back that a revoke is (revoke keeps its instant
`kill()` on the revoke event). The sweep also silently covers a grant that
expires while the phone is backgrounded.

### 4. The dashboard shows it

Guest device rows show the expiry: "Guest · expires in 3h", "expires tomorrow",
or "expired" (an expired-but-not-revoked grant renders like a spent pass, and
Delete cleans it up — same as a revoked row). `expiresAt` is already on the grant;
`/api/state` just surfaces it.

### 5. The phone needs no change (for MVP)

An expired guest experiences exactly what a revoked device does — the next
request is denied and the client shows "lost the connection to your library"
(graceful-reconnect, 2026-07-14). Telling the guest "your pass expires in 2h" is
nice but is polish, and it is additive later. MVP is host + dashboard only.

## Security review

- **Grant store stays host-local and never replicated.** Unchanged. ✓
- **Expiry is enforced in TWO places, like revoke:** `decide()` at connect, and
  the sweep for a live connection. Shipping only the first would let a guest
  stream past expiry until reconnect — the exact bug `Connections` was built to
  prevent, now for time instead of revoke.
- **The device cannot set its own expiry.** Duration is fixed by the operator when
  the window opens; the hello carries only a label. Self-declared identity must not
  become authority (2026-07-14 naming rule).
- **Revoke is unchanged and still instant.** A guest can still be revoked early;
  expiry is an *additional* cut, not a replacement.
- **Clock:** expiry uses the host's wall clock (`Date.now()`), same as
  `grantedAt`/`revokedAt`. A host clock jump would move expiry with it; acceptable
  (the host is the authority on time here, as on admission).

## Verify

- Unit: `gate.decide()` expiry branch (already tested — assert it stays green),
  plus the sweep's selection logic (which live devices to kill) as a pure function.
- Hardware (TCL + Umbrel): open a guest window with a **short** custom duration
  (e.g. 2 minutes), pair the TCL through it, confirm it streams; then wait past
  expiry and confirm (a) the live connection is cut within ~30 s (playback stops,
  "lost the connection"), and (b) a reconnect is denied (`grant-expired`). Confirm
  the dashboard row shows the countdown then "expired". Confirm a NORMAL pairing
  still mints a non-expiring grant (unchanged).

## Out of scope (follow-ups)

- Library-subset (`paths`) scopes — their own proposal.
- Editing/extending expiry on an existing device from the dashboard (this MVP
  extends by re-pairing through a guest window).
- A client-facing "guest, expires in X" banner.
