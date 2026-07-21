# Client self-leave: removing a library ends the grant on the host

**Goal** — when a device removes a library (or unpairs), tell that host to drop the device's *own*
grant, so a departure the user made on the phone is reflected on the operator's dashboard instead of
leaving a live grant and a stale row behind.

**Tier** — T3 (touches the grant/revoke core: the host's allow-list).

## Problem

`removeHost` / `forget` are local-only by design (see `src/bare.js`: *"the host still holds the old
grant; it can revoke it if it wants the row gone"*). Two consequences the user hit:

1. The device + person rows persist on every host's People & Devices list after the phone removed
   the library — nothing told the host.
2. Worse than cosmetic: **the grant stays LIVE**. "Remove library" doesn't actually end the phone's
   access at the host; it hides it locally, and a re-pair would silently restore access with no
   operator re-confirmation. "Remove" doesn't mean what it says, and the host — which CLAUDE.md makes
   the sole authority on access — never learns the device chose to leave.

## Scope

**Changes:**
- New media method **`device.leave`** (no params). The handler revokes *this connection's own* grant
  (`grant.deviceKey`, the Noise-authenticated key — never a client parameter) and cuts the
  connection, the same teeth as an operator revoke, logged `host:device-left`. Allowed for ANY scope
  (a device dropping its own access is the least-privileged possible action; a read-only device may
  leave too), so it is deliberately NOT in the `MUTATING` scope gate.
- Host `leaveDevice(deviceKey)` mirroring `revokeDevice` (revoke + `connections.kill`), wired into
  `serveMedia` as an `onLeave` callback.
- Client `deviceLeave()` RPC. `removeHost` and `forget` call it **best-effort** on each removed
  host's live connection before tearing the connection down; a rejection/close is swallowed.

**Does NOT change:**
- The offline path. If the host is unreachable when you remove the library, nothing is sent — the
  row persists exactly as today, and the operator can still delete it by hand. Self-leave is a
  best-effort courtesy, not a guarantee; we do NOT queue a self-revoke to fire on some later connect
  (a delayed, unattended self-revoke is surprising, and you can't reach a host you can't reach).
- Person rows. We do NOT auto-delete a Person. Revoke tombstones the device, and the dashboard
  already HIDES revoked rows behind its "show revoked" toggle (PR #12) — so a left device disappears
  from the default view while the tombstone stays auditable, and a Person that still holds other
  devices (Tim's "Tim" also has the TCL) is untouched. Auto-pruning an operator-named Person is
  destructive and conflates *disconnect* (transient — must never delete anything) with *leave*;
  left to the operator's existing one-click delete. See Open questions.

## Compat

No wire/channel change — `device.leave` is a new method string on the existing media req/res, exactly
like the favorites/session methods were. An **old host** answers `ENOMETHOD`; the client swallows it
and falls back to today's local-only behavior. An **old client** never sends it. Fully backward-
compatible; no migration.

## Verify

`npm run verify` (host integration test over real DHT: pair → connect → `deviceLeave()` → the grant
is revoked and the live connection killed; a read-only grant can still leave; a *second* device under
the same person is untouched). Then on-device: on the Pixel, in a blend, remove one library while
connected — its device row leaves the host's default Devices list within a second; the TCL (also under
"Tim") is unaffected and "Tim" persists.

## Rollback

Revert the change. Clients fall back to local-only `removeHost`/`forget`; hosts simply stop receiving
`device.leave`. No persisted state depends on it (a revoke tombstone is the same shape an operator
revoke produces).

## Open questions

- **Revoke vs delete the row.** This revokes (tombstones), so the row is hidden-by-default but
  auditable under "show revoked". Deleting it outright would match "gone" more literally but loses the
  audit trail and the security model refuses deleting a *live* grant (must revoke first anyway).
  Chosen: revoke.
- **Person auto-prune.** Should a leave that empties a Person (all its devices revoked) auto-delete an
  un-renamed / auto-created Person, while keeping operator-named ones? Deferred — manual for now.
