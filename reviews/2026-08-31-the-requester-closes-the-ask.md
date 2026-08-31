# Review: the requester closes the ask (T3)

Shipped per proposal `proposals/2026-08-31-the-requester-closes-the-ask.md`, approved by
Tim 2026-08-31 (AskUserQuestion, "Approve, implement"). What shipped: the
`owner.requestResolve` gate widens to admit the row's own requester, but only to mark a
still-pending copy `added` (a decline never travels and a requester cannot flip an
owner's decline); a pure `answeredElsewhere` rule in worklet/merge.js; and a healing
pass in the worklet's merged `requestList` that closes answered asks' pending sibling
copies fire-and-forget, so a dashboard resolve on one host stops showing as pending on
every other owner's queue. Verified by `npm run verify` (1064/1064, 6 new tests) - the
two-host DHT-testnet tests walk the exact end-to-end story: an `added` on host A closes
B's copy through the requester's own reconcile steps, a `declined` on A leaves B
pending, a stranger is refused and an old host degrades to today's bug rather than an
error. No UI change and no on-device behaviour beyond the lists healing, so no separate
emulator run.
