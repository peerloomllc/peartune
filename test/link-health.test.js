// The connection watchdog's decision, pinned.
//
// The bug it exists for: a phone reconnected to one host in seconds while another stayed
// missing for 20+ minutes (TODO, Tim, 2026-07-26). The A/B proved the fault followed the
// ROLE - whichever library was not the active one died quietly, because the active
// connection is repaired by ordinary use and nothing else was. P1 of the one-connection-
// per-library proposal makes the POLICY role-blind; these tests pin that, plus the two
// things that keep it safe: a busy connection is never probed, and a dark one is always
// retried.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  linkActions, stuckDialAction, WATCHDOG_MS, PING_TIMEOUT_MS, PROVEN_WINDOW_MS
} = require('../worklet/link-health')

const HOSTS = [
  { hostKey: 'aaa', libraryId: 'lib-active' },
  { hostKey: 'bbb', libraryId: 'lib-pool-1' },
  { hostKey: 'ccc', libraryId: 'lib-pool-2' }
]
const NOW = 1_000_000

const run = (over = {}) => linkActions({
  hosts: HOSTS,
  activeLibraryId: 'lib-active',
  isLive: () => false,
  provenAt: () => 0,
  now: NOW,
  ...over
})

test('every dark library is redialed, the ACTIVE one included', () => {
  // The whole point of P1. Before it, the active library was skipped here on the assumption
  // that ordinary RPC traffic would repair it - true only while the app is being used.
  assert.deepEqual(
    run().map((a) => [a.libraryId, a.action]),
    [['lib-active', 'redial'], ['lib-pool-1', 'redial'], ['lib-pool-2', 'redial']]
  )
})

test('an action says which role it is, so the caller can drive the right machinery', () => {
  // joinActiveTopic and joinPoolTopic are still different code paths until P2. The DECISION
  // is role-blind; the plumbing is not, yet.
  const byLib = Object.fromEntries(run().map((a) => [a.libraryId, a.active]))
  assert.equal(byLib['lib-active'], true)
  assert.equal(byLib['lib-pool-1'], false)
})

test('a live library that traffic has NOT proved lately is probed', () => {
  const actions = run({ isLive: () => true, provenAt: () => NOW - PROVEN_WINDOW_MS - 1 })
  assert.deepEqual(actions.map((a) => a.action), ['probe', 'probe', 'probe'])
})

test('a BUSY connection is never probed', () => {
  // Load-bearing, not an optimisation: requests and stream chunks share one mux, so a ping
  // issued behind a track's worth of audio on a slow link could time out on a healthy
  // connection - and the watchdog answers a failed probe by destroying the socket. That
  // would cut the music. Traffic in the window IS the proof, so no ping is sent.
  const actions = run({ isLive: () => true, provenAt: () => NOW - 1000 })
  assert.deepEqual(actions, [])
})

test('a live connection that has never heard anything is probed', () => {
  // lastActivityAt 0 = a fresh attach with no inbound frame yet. Probing it is how we learn
  // whether it actually carries traffic, and it costs one ping.
  const actions = run({ isLive: () => true, provenAt: () => 0 })
  assert.deepEqual(actions.map((a) => a.action), ['probe', 'probe', 'probe'])
})

test('dark beats proven: a library with no client is redialed however recent its traffic', () => {
  const actions = run({ isLive: (lib) => lib !== 'lib-pool-1', provenAt: () => NOW - 10 })
  assert.deepEqual(actions.map((a) => [a.libraryId, a.action]), [['lib-pool-1', 'redial']])
})

test('a duplicated host record yields ONE action', () => {
  const actions = linkActions({
    hosts: [...HOSTS, { hostKey: 'bbb', libraryId: 'lib-pool-1' }],
    activeLibraryId: 'lib-active',
    isLive: () => false,
    now: NOW
  })
  assert.equal(actions.filter((a) => a.libraryId === 'lib-pool-1').length, 1)
})

test('junk host records are skipped rather than throwing', () => {
  const actions = linkActions({
    hosts: [null, {}, { libraryId: 'lib-pool-1', hostKey: 'bbb' }],
    activeLibraryId: 'lib-active',
    isLive: () => false,
    now: NOW
  })
  assert.deepEqual(actions.map((a) => a.libraryId), ['lib-pool-1'])
})

test('no paired libraries means nothing to do', () => {
  assert.deepEqual(linkActions({ hosts: [], activeLibraryId: null, isLive: () => false, now: NOW }), [])
})

test('the action carries the host record, so the caller can re-join its topic', () => {
  // joinPoolTopic/joinActiveTopic need hostKey, not just the libraryId - a redial that could
  // not name the topic would be a no-op, which is the failure this watchdog exists to prevent.
  assert.equal(run()[0].host.hostKey, 'aaa')
})

test('the probe timeout is shorter than the watchdog interval', () => {
  // Otherwise a stuck ping is still outstanding when the next tick starts one, and the ticks
  // pile up on a connection already known to be bad.
  assert.ok(PING_TIMEOUT_MS < WATCHDOG_MS)
})

test('the proven window is shorter than the watchdog interval', () => {
  // Otherwise every tick would find the previous tick's own probe inside the window and skip -
  // an idle connection would never be probed at all.
  assert.ok(PROVEN_WINDOW_MS < WATCHDOG_MS)
})

// --- the stuck dial (Tim, 2026-07-30) ---------------------------------------
//
// A booking hyperswarm made at dial time that never opened. It blocks every future dial for
// that peer (index.js:199 returns early while _allConnections has the key), so the failure mode
// is "never reconnects until the app is restarted" - which is what Tim reported. Caught on his
// Pixel after Android's cached-app freezer held the process ~13 minutes: nudge:link showed
// conns:1 / live:0 and the reconnect failed.
//
// What these pin is the SAFETY of the clear, not the clearing: an in-flight hole-punch looks
// identical from here and has been measured at 8-28s off-LAN, so a rule that fires too eagerly
// would break connections that were about to succeed.

const GAP = 30000 // suspendGapMs
const HOLD = 30000 // holdMs

test('no booking, nothing to clear', () => {
  assert.strictEqual(stuckDialAction({ hasStuck: false, lastTickAt: 1, now: 10 * 60000, suspendGapMs: GAP, holdMs: HOLD }), null)
})

test('a suspension clears it at once - the observed case', () => {
  // Ticked at t=0, next tick 13 minutes later: the worklet was frozen in between.
  const now = 13 * 60000
  assert.strictEqual(
    stuckDialAction({ hasStuck: true, stuckSince: now, lastTickAt: 0 + 1, now, suspendGapMs: GAP, holdMs: HOLD }),
    'suspended'
  )
})

test('an on-time tick is NOT a suspension, however long the booking has been there', () => {
  // 10s apart is the normal cadence. The booking is fresh, so nothing fires yet.
  assert.strictEqual(
    stuckDialAction({ hasStuck: true, stuckSince: 100000, lastTickAt: 100000, now: 110000, suspendGapMs: GAP, holdMs: HOLD }),
    null
  )
})

test('the FIRST tick never counts as a suspension', () => {
  // lastTickAt 0 means we have not ticked yet, so there is no gap to measure and a long
  // wall-clock time cannot be read as a freeze. A booking made moments ago is a dial in
  // progress, not a stranded one, and must survive.
  const now = 10 * 60000
  assert.strictEqual(
    stuckDialAction({ hasStuck: true, stuckSince: now - 2000, lastTickAt: 0, now, suspendGapMs: GAP, holdMs: HOLD }),
    null
  )
  // ...but the hold backstop still applies on that first tick, or a booking stranded before we
  // started ticking would be immortal.
  assert.strictEqual(
    stuckDialAction({ hasStuck: true, stuckSince: now - HOLD, lastTickAt: 0, now, suspendGapMs: GAP, holdMs: HOLD }),
    'held'
  )
})

test('a punch still in flight at 28s is NOT aborted', () => {
  // The slowest hole-punch we have measured (Start9, 2026-07-29). Clearing this would break a
  // connection that was about to succeed, which is the whole risk of this fix.
  assert.strictEqual(
    stuckDialAction({ hasStuck: true, stuckSince: 0, lastTickAt: 0, now: 28000, suspendGapMs: GAP, holdMs: HOLD }),
    null
  )
  assert.strictEqual(
    stuckDialAction({ hasStuck: true, stuckSince: 1000, lastTickAt: 20000, now: 29000, suspendGapMs: GAP, holdMs: HOLD }),
    null
  )
})

test('a booking held past holdMs with no suspension is cleared as the backstop', () => {
  assert.strictEqual(
    stuckDialAction({ hasStuck: true, stuckSince: 1000, lastTickAt: 25000, now: 31000, suspendGapMs: GAP, holdMs: HOLD }),
    'held'
  )
})

test('suspension wins over held, so the reason logged is the true one', () => {
  assert.strictEqual(
    stuckDialAction({ hasStuck: true, stuckSince: 1000, lastTickAt: 1000, now: 600000, suspendGapMs: GAP, holdMs: HOLD }),
    'suspended'
  )
})
