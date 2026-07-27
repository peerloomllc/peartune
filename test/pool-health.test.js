// The pool watchdog's decision, pinned.
//
// The bug it exists for: a phone reconnected to one host in seconds while another stayed
// missing for 20+ minutes and then returned by itself (TODO, Tim, 2026-07-26). The active
// host is retried by every RPC the app makes; a pool host is retried by nothing but its own
// nudge timer, which can stop with the host still dark. These tests pin the two things the
// watchdog must get right: it retries a dark host, and it puts real traffic on a live one so
// a dead-but-undestroyed socket cannot masquerade as a connected library.

const test = require('node:test')
const assert = require('node:assert/strict')

const { poolActions, POOL_WATCHDOG_MS, POOL_PING_TIMEOUT_MS } = require('../worklet/pool-health')

const HOSTS = [
  { hostKey: 'aaa', libraryId: 'lib-active' },
  { hostKey: 'bbb', libraryId: 'lib-pool-1' },
  { hostKey: 'ccc', libraryId: 'lib-pool-2' }
]

const run = (over = {}) => poolActions({
  merged: true,
  hosts: HOSTS,
  activeLibraryId: 'lib-active',
  isLive: () => false,
  ...over
})

test('a dark pool host is redialed', () => {
  const actions = run({ isLive: () => false })
  assert.deepEqual(
    actions.map((a) => [a.libraryId, a.action]),
    [['lib-pool-1', 'redial'], ['lib-pool-2', 'redial']]
  )
})

test('a live pool host is probed, not redialed', () => {
  const actions = run({ isLive: (lib) => lib === 'lib-pool-1' })
  assert.deepEqual(
    actions.map((a) => [a.libraryId, a.action]),
    [['lib-pool-1', 'probe'], ['lib-pool-2', 'redial']]
  )
})

test('the ACTIVE host is never a watchdog target', () => {
  // It rides the active client and startActiveNudge. Probing it here would double up on the
  // connection the whole app is already using, and redialing it would fight joinActiveTopic.
  const actions = run({ isLive: () => true })
  assert.ok(!actions.some((a) => a.libraryId === 'lib-active'))
})

test('outside merged mode there is nothing to keep alive', () => {
  // The pool is only read by the blend. Pinging hosts nobody is reading would be pure battery.
  assert.deepEqual(run({ merged: false }), [])
})

test('the action carries the host record, so the caller can re-join its topic', () => {
  // joinPoolTopic needs hostKey, not just the libraryId - a redial that could not name the
  // topic would be a no-op, which is the failure this whole watchdog exists to prevent.
  const [first] = run()
  assert.equal(first.host.hostKey, 'bbb')
})

test('a duplicated host record yields ONE action', () => {
  const actions = poolActions({
    merged: true,
    hosts: [...HOSTS, { hostKey: 'bbb', libraryId: 'lib-pool-1' }],
    activeLibraryId: 'lib-active',
    isLive: () => false
  })
  assert.equal(actions.filter((a) => a.libraryId === 'lib-pool-1').length, 1)
})

test('junk host records are skipped rather than throwing', () => {
  const actions = poolActions({
    merged: true,
    hosts: [null, {}, { libraryId: 'lib-pool-1', hostKey: 'bbb' }],
    activeLibraryId: 'lib-active',
    isLive: () => false
  })
  assert.deepEqual(actions.map((a) => a.libraryId), ['lib-pool-1'])
})

test('the probe timeout is shorter than the watchdog interval', () => {
  // Otherwise a stuck ping is still outstanding when the next tick starts one, and the ticks
  // pile up on a connection that is already known to be bad.
  assert.ok(POOL_PING_TIMEOUT_MS < POOL_WATCHDOG_MS)
})
