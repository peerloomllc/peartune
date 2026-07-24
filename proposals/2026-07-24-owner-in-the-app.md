# Owner in the app: remote maintenance + a music-request queue

**Goal** — let the library's OWNER do basic maintenance from their phone when they
are away from the server (revoke a device, open a pairing window, see who is on),
and let any paired device REQUEST music the operator then fulfils - all with
in-app, connection-alive notifications and **no cloud, no third-party push**.

**Tier** — **T3.** It mints a new, elevated grant scope (`owner`) that can issue
commands affecting OTHER devices, and it adds a new command surface on
`peartune/media/1`. A device that can revoke other people is a privilege we did
not have before; get it wrong and a lost phone locks a household out. Proposal +
rollback + RCA readiness per Constitution §2.

---

## Why this shape (the discussion that produced it)

The original backlog item was just "request music": let a phone ask the host to
add a track. The blocker Tim named: with **no push infrastructure anywhere in the
suite** (confirmed - no expo-notifications, no FCM/APNs, no web-push, no email in
app or host, by the no-cloud design), how does the owner ever learn a request came
in? A dashboard badge only shows while the dashboard is open, which for a
set-and-forget Umbrel is rarely.

Tim's reframe dissolves it: give the OWNER a presence in the mobile app. Their
phone is already a PearTune client that holds a live, Noise-authenticated channel
to the host. So the host can push "a request arrived" to the owner's phone the
same way it already pushes session-handoff (presence.js) - **while the app is
connected**. That is Tier A, chosen 2026-07-24: no wake of a closed app, no third
party, best-effort but honest. The requests queue stops being a dead-drop nobody
reads and becomes a thing the owner works from their pocket.

And once the owner has an authenticated, elevated presence in the app, the
requests queue is just the first tenant of a small **maintenance surface** - the
handful of operations you want when something is wrong and you are not at the
server: revoke a device, open a pairing window, glance at who is connected.

### Explicitly NOT in this design

- **Push to a closed app.** Tier B (Expo→FCM/APNs relay for a content-free ping)
  was on the table and Tim declined it to keep the no-cloud principle whole.
  Notifications here are in-app and require a live connection. Revisit only if the
  suite ever grows real push for another reason.
- **Auto-download / *arr integration.** A fulfilled request is still the operator
  adding the music by hand (or via their own downloader); it appears on the next
  source scan. Auto-fulfil is a future follow-on, out of scope.

---

## What already exists (so the new surface is small)

- **Grants carry a `scope`** (`full` | `readonly`), enforced by the `MUTATING` set
  in `host/media.js` - a readonly grant is refused at the dispatch, not the
  adapter, so a new mutating method cannot ship without a check. `grant:{deviceKey}`
  already reserves `scope` and `paths`, so a new `owner` scope is a **value
  change, not a migration** (grants.js header, and the source.json precedent).
- **Presence** (`host/presence.js`) is a `deviceKey -> Set<pushFn>` registry of
  live media channels, populated in `serveMedia` AFTER the grant check and torn
  down on channel close (so a revoked device is unreachable). It already backs
  host→phone session-handoff. A `request:new` push to the owner rides the same
  rail with no new transport.
- **The host-local state Hyperbee** (`host/state.js`, `UserState`) stores rows by
  prefix and is **not replicated**. Requests live here under a `request:` prefix,
  exactly like the grant store is host-local authority - a requester cannot forge
  or replay one into the ledger, because there is no ledger.
- **The dashboard pair modal** (`PairModal`, `Pair.jsx`) already opens a window
  and shows a QR + link. "Pair as owner" is a variant of it.
- **The media dispatch** is a flat `case` table; `owner.*` and `request.*` slot in
  as new cases behind the scope gate.

---

## Design

### 1. Owner identity = dashboard access

The trust root already exists: **whoever can open the dashboard is the owner**
(it is password-gated, or loopback-only). So proving ownership from the app is not
a new secret - it is a pairing window that the dashboard, and only the dashboard,
can open.

- The dashboard gets a **"Pair my phone as owner"** action (gear menu, next to
  Setup guide). It opens a pairing window flagged `owner: true`.
- A device that pairs through it is granted `scope: 'owner'` instead of `full`.
  Everything else about pairing is unchanged (same handshake, same rv-token proof,
  same one-shot window).
- `owner` is a strict superset of `full`: it can browse/stream/favorite like any
  device, PLUS call the `owner.*` maintenance methods and see all requests.

Rationale for reusing pairing rather than a password prompt in the app: the app
never has to hold or transmit the dashboard password (no bearer credential on the
phone - Constitution "no bearer tokens, ever"), and the elevated grant is
revocable from the dashboard like any other, so an owner phone that is lost is
cut off the same way any device is.

### 2. The maintenance surface (`owner.*` on `peartune/media/1`)

All gated on `grant.scope === 'owner'`, checked at dispatch. v1 set, deliberately
small - the things you actually want away from the server:

- `owner.devices` — the People & devices list the dashboard shows (read).
- `owner.revoke { deviceKey }` — revoke a device. Reuses `host.revokeDevice`,
  which already tombstones the grant AND kills live connections (<1s, the core T3
  guarantee). Not "future only" - a revoke from the owner phone must cut a device
  off now, same as from the dashboard.
- `owner.pairStart { expiresMs? }` / `owner.pairStop` — open/close a normal
  (non-owner) pairing window remotely, so you can let someone in while out.
- `owner.requests` — the full request queue (all requesters).
- `owner.request.resolve { id, status }` — mark a request `added` | `declined`.

Notably ABSENT from v1: minting owner grants from the phone (only the dashboard
promotes to owner - an owner phone cannot make more owner phones), deleting people,
changing the source, rotating the password. Those stay dashboard-only; they are
either destructive or rarely-remote, and keeping them off the phone bounds the
blast radius of a stolen owner device.

### 3. Requests

- New `request.add { kind: 'artist'|'album'|'track', name, artist?, album?, mbid? }`
  on the media channel, allowed for any non-readonly grant (revoke kills it - same
  posture as favorites). Owner scope not required to REQUEST, only to fulfil.
- Host stores `request:{id}` in the state bee (host-local, not replicated):
  `{ id, requester: ownerId, kind, name, artist?, album?, mbid?, status:
  'pending'|'added'|'declined', createdAt, resolvedAt? }`. `requester` is the
  Noise-derived `personId ?? deviceKey` (host-side, unforgeable - the same
  ownerId favorites/resume use).
- `request.list` — the requester sees THEIR OWN pending/resolved requests.
  `owner.requests` — the owner sees ALL.
- **Dedup**: a new request whose `(kind, norm(name), norm(artist))` matches a
  still-pending one is folded into it (a `count`), not added twice.

### 4. Notifications (Tier A - in-app, connection-alive)

- **Owner ← new request.** On `request.add`, the host pushes `request:new` to the
  owner's live channels via presence (every device with an `owner`-scope grant
  that is currently connected). The owner app shows an in-app banner + a badge on
  the (new) Requests screen. If no owner is connected, the request simply waits;
  the badge/count is there next time an owner opens the app.
- **Requester ← fulfilled.** On `owner.request.resolve`, the host pushes
  `request:resolved` to the requester's live channels. If they are offline, they
  see the status on next `request.list` (lazy).
- **Dashboard** also shows a "Requests (N)" badge off the existing `/api/state`
  poll, so an owner at the server sees the same queue. Free - it is one more field
  on state.

Everything here is best-effort by construction: no push means no guarantee, and we
say so in the UI copy ("You'll see requests when you open PearTune").

---

## Phasing

Land incrementally; each phase is independently shippable and useful.

- **P1 — Requests, dashboard-only.** `request.add`/`list`, the state rows, dedup, a
  dashboard Requests panel with resolve, the `/api/state` badge. No owner-in-app
  yet - the operator works requests from the dashboard. Delivers the core queue.
  Lowest risk (no new scope, no elevated commands).
- **P2 — Owner pairing + the app maintenance surface.** The `owner` scope,
  "pair as owner" on the dashboard, `owner.*` methods, the app's owner screen
  (devices/revoke/pair/requests). This is the T3-heavy part - the elevated grant.
- **P3 — Tier A notifications.** `request:new` to owners, `request:resolved` to
  requesters, in-app banners + badges. Rides presence; pure addition.

P1 alone answers "is the queue worth it" on real use before we build the elevated
scope. If P1 shows nobody files requests, P2/P3 never get built and we have risked
almost nothing.

---

## Security review

The whole reason this is T3. The two rules that matter most (CLAUDE.md) both bear
on it:

1. **The grant store stays host-local authority.** `owner` is just another grant
   value in the same host-local store; nothing about it is replicated or
   phone-asserted. A phone cannot claim owner scope - only a pairing through the
   dashboard's owner-window mints it, and the host is the sole writer.
2. **Revoke must kill live connections.** `owner.revoke` reuses the existing
   `revokeDevice` (tombstone + connections.kill), so an owner-phone revoke cuts the
   target off within the second, not "on next connect". And revoking the owner
   phone ITSELF is a normal dashboard revoke: presence unregisters on channel
   close, so a cut owner cannot push, list, or command.

New risks this introduces, and the mitigations baked into the design above:

- **A stolen/lost owner phone can revoke others / let strangers in.** Mitigated by
  (a) bounding v1 owner powers - no minting owner grants, no deleting people, no
  source/password changes from the phone; (b) the dashboard can always revoke the
  owner phone, and the host stays the authority; (c) owner scope is opt-in per
  device (you pair a phone as owner deliberately). Open question below on an extra
  confirmation for destructive owner actions.
- **A requester spamming `request.add`.** Rate-limited per requester + the dedup
  fold; a readonly grant cannot request at all; revoke kills it.
- **`request.add` free-text (name/artist) is operator-facing.** The dashboard
  renders it - it MUST be escaped (React escapes by default; the dashboard already
  had one stored-XSS via innerHTML, DECISIONS - do not reintroduce raw
  interpolation). Length-capped on the host.
- **Owner methods must NOT be reachable on a pairing-only connection.** Same
  guarantee media already has: `owner.*` lives on the media channel, which only
  exists post-grant; a pair connection never gets one.

---

## Compat

- **Old phones**: never send `request.*`/`owner.*`, unaffected. An owner-scoped
  grant reads as `full` to any check that does not know `owner` (superset), so an
  old client with an owner grant just behaves as a normal full client - safe
  degradation.
- **Old hosts**: a new client calling `request.add` against a host that lacks it
  gets a method-not-found; the app feature-detects (like it does for favorites /
  playlists on older hosts) and hides the affordance.
- **Grant schema**: `scope: 'owner'` is a value in the existing field; `request:`
  is a new state-bee prefix. No migration.

## Verify

- Unit: dedup key folding; the scope gate refuses `owner.*` for full/readonly
  grants; `request.add` refused for readonly; requester sees only own requests,
  owner sees all.
- Harness/hardware: pair a phone as owner off the dashboard; from the owner phone
  revoke a second device and confirm it is cut off within a second (the T3 gate);
  file a request from a normal device and confirm the owner phone banners it while
  connected and badges it after; resolve it and confirm the requester sees
  fulfilled. Revoke the owner phone from the dashboard and confirm its `owner.*`
  calls stop.
- `npm run verify` green.

## Rollback

- P1 is additive (new methods + rows + a dashboard panel); reverting the commit
  removes the surface, and stale `request:` rows are inert (nothing reads them).
- P2's `owner` scope: revert leaves any minted owner grants reading as `full`
  (superset) - safe; no device gains anything, they lose the `owner.*` surface
  because the methods are gone.
- No wire-breaking change to existing methods, so a rolled-back host still talks to
  every existing client.

## Open questions

1. **A second confirmation for destructive owner actions from the phone?** e.g.
   owner.revoke double-confirms in-app. Cheap; probably yes.
2. **Should the owner phone see a request's free-text before it is escaped
   anywhere?** (It renders in the app too - same escaping rule as the dashboard.)
3. **Guest/readonly requesters**: allow requests from a guest pass, or restrict to
   permanent grants? Leaning allow (revoke/expiry already bounds them).
4. **More than one owner phone**: allowed (each paired via the dashboard). Any cap?
   Probably no cap; they are all revocable.
5. **P1 dashboard-only worth shipping alone**, or only build once P2/P3 make it
   pocket-worked? (Recommend P1 alone as the value probe.)
