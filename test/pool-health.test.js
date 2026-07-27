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
  poolActions, POOL_WATCHDOG_MS, POOL_PING_TIMEOUT_MS, PROVEN_WINDOW_MS
} = require('../worklet/pool-health')

const HOSTS = [
  { hostKey: 'aaa', libraryId: 'lib-active' },
  { hostKey: 'bbb', libraryId: 'lib-pool-1' },
  { hostKey: 'ccc', libraryId: 'lib-pool-2' }
]
const NOW = 1_000_000

const run = (over = {}) => poolActions({
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
  const actions = poolActions({
    hosts: [...HOSTS, { hostKey: 'bbb', libraryId: 'lib-pool-1' }],
    activeLibraryId: 'lib-active',
    isLive: () => false,
    now: NOW
  })
  assert.equal(actions.filter((a) => a.libraryId === 'lib-pool-1').length, 1)
})

test('junk host records are skipped rather than throwing', () => {
  const actions = poolActions({
    hosts: [null, {}, { libraryId: 'lib-pool-1', hostKey: 'bbb' }],
    activeLibraryId: 'lib-active',
    isLive: () => false,
    now: NOW
  })
  assert.deepEqual(actions.map((a) => a.libraryId), ['lib-pool-1'])
})

test('no paired libraries means nothing to do', () => {
  assert.deepEqual(poolActions({ hosts: [], activeLibraryId: null, isLive: () => false, now: NOW }), [])
})

test('the action carries the host record, so the caller can re-join its topic', () => {
  // joinPoolTopic/joinActiveTopic need hostKey, not just the libraryId - a redial that could
  // not name the topic would be a no-op, which is the failure this watchdog exists to prevent.
  assert.equal(run()[0].host.hostKey, 'aaa')
})

test('the probe timeout is shorter than the watchdog interval', () => {
  // Otherwise a stuck ping is still outstanding when the next tick starts one, and the ticks
  // pile up on a connection already known to be bad.
  assert.ok(POOL_PING_TIMEOUT_MS < POOL_WATCHDOG_MS)
})

test('the proven window is shorter than the watchdog interval', () => {
  // Otherwise every tick would find the previous tick's own probe inside the window and skip -
  // an idle connection would never be probed at all.
  assert.ok(PROVEN_WINDOW_MS < POOL_WATCHDOG_MS)
})
