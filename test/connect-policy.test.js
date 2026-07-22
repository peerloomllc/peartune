// The connect retry policy, pinned against MEASURED field timings.
//
// This file exists because the first version of the retry got the arithmetic wrong in a way
// no functional test would catch: it retried, the retry was correct, and it still failed in
// the field - because the budget stopped it one attempt before the one that connected.
//
// From Tim's Pixel, off-LAN on 5G (2026-07-22), both hosts, with and without Tailscale:
//
//   Umbrel: fail 4141ms,  fail 10360ms, OK 489ms
//   Mac:    fail 11563ms, fail 11661ms, OK 1658ms
//   Mac:    (Tailscale off) reached on try 3 after 21364ms total
//
// So: a failing attempt costs up to ~11.7s, and the successful one arrives on try 2 or 3.
// A budget that cannot START a third attempt after two failures is useless on this network.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  CONNECT_ATTEMPTS, CONNECT_RETRY_BUDGET_MS, CONNECT_RETRY_GAP_MS,
  CONNECT_TIMEOUT, OBSERVED_WORST_ATTEMPT_MS
} = require('../client')

test('the budget still allows a THIRD attempt after two worst-case failures', () => {
  // The loop checks the budget AFTER a failure and before sleeping, so what matters is the
  // elapsed time at the moment attempt 3 would start.
  const elapsedBeforeThird = 2 * OBSERVED_WORST_ATTEMPT_MS + 2 * CONNECT_RETRY_GAP_MS
  assert.ok(
    CONNECT_RETRY_BUDGET_MS > elapsedBeforeThird,
    `budget ${CONNECT_RETRY_BUDGET_MS}ms must exceed ${elapsedBeforeThird}ms, or two slow ` +
    'failures end the loop before the attempt that actually connects (the 14s cut did exactly that)'
  )
})

test('there are enough attempts for the observed success-on-try-3', () => {
  assert.ok(CONNECT_ATTEMPTS >= 3, 'successes were seen on try 2 AND try 3 in the field')
})

test('a single attempt is allowed to take longer than a hole-punch takes to give up', () => {
  // hyperdht abandons a punch around 11.5s. A per-attempt timeout below that would cut the
  // attempt short and we would never see the punch resolve either way.
  assert.ok(
    CONNECT_TIMEOUT > OBSERVED_WORST_ATTEMPT_MS,
    `per-attempt timeout ${CONNECT_TIMEOUT}ms must exceed the ~${OBSERVED_WORST_ATTEMPT_MS}ms a punch takes to abort`
  )
})

test('the whole policy still bounds how long a user waits', () => {
  // Not unbounded: the budget caps it, and a host that is simply OFF fails in milliseconds
  // (PEER_NOT_FOUND), so this ceiling is only reachable when the host was actually found.
  assert.ok(CONNECT_RETRY_BUDGET_MS <= 60_000, 'a minute is the outer limit of reasonable')
})
