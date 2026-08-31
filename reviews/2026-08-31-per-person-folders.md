# Review: per-person folders (T3)

Shipped as PR #405 per proposal `proposals/2026-08-31-per-person-folders.md`, approved by
Tim 2026-08-31 and merged on his review the same day (he inspected the live preview
dashboard before saying merge). What shipped: `host/visibility.js` (the one rule +
`viewOf`), the folder adapter's narrowed view over filtered in-memory pools with the art
gate ahead of the shared cache, the per-dispatch chokepoint in `host/media.js` riding
#402's live-grant plumbing, fail-closed service for sources that cannot enforce a
narrowing, path inheritance on `assign()`, pairing windows that carry paths (the panel
asks, nothing preselected), the People page's Can-hear line + folder picker, and the
phone-side browse/blend rebuild on `grant:changed`. Verified by `npm run verify`
(1058/1058, 19 new tests including three over a real DHT testnet) and an emulator
end-to-end run (Songs 4->2->4->1 in place, no reconnect), which also caught the
stale-open-list bug fixed in the same PR. The TCL hardware smoke remains open, logged in
TODO.
