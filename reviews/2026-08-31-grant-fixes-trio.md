# Review: grant fixes trio (T3)

Shipped per proposal `proposals/2026-08-31-grant-fixes-trio.md`, approved by Tim 2026-08-31
(AskUserQuestion, "Approve, implement"). What shipped: recorded claim confirmation
(`confirmedUser`, `settleClaim`, rename backfill), the revoked-device goodbye
(`mayBeToldWhy` + `FarewellBook` + `serveFarewell`, phone-side persisted verdict with
fail-fast dialing and a 5-minute re-admission probe) and live grant refresh
(`serveMedia().setGrant` + `host.assignDevice` + `grant:changed`). Verified by
`npm run verify` (1027/1027, 8 new tests including the reshaped headline revoke test over a
real DHT testnet) and an end-to-end emulator run against a local host: goodbye received
200ms after a mid-song revoke, "Access removed" wall shown and persisted across relaunch,
knocking measured quiet after the boot window, re-pair restored access immediately.
Hardware smoke on the TCL against the Umbrel remains open, logged in TODO.
