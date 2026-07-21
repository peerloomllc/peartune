// The PENDING LEAVES queue - what remembers "I removed this library while its server was
// off" so the host is told on a later launch. What is worth pinning: re-queueing the same
// host never stacks, a re-pair CANCELS the queued leave (otherwise the retry would revoke
// the grant the user just made), and the queue gives up eventually instead of dialling a
// dead key forever.

const test = require('node:test')
const assert = require('node:assert/strict')
const L = require('../worklet/leaves')

const A = { hostKey: 'aaa', libraryId: 'libA', libraryName: "Tim's Umbrel" }
const B = { hostKey: 'bbb', libraryId: 'libB', libraryName: "Tim's Mac" }

test('queueLeave() remembers a host, with a timestamp and no attempts yet', () => {
  const q = L.queueLeave([], A, 1000)
  assert.equal(q.length, 1)
  assert.deepEqual(q[0], {
    hostKey: 'aaa', libraryId: 'libA', libraryName: "Tim's Umbrel", queuedAt: 1000, attempts: 0
  })
})

test('queueLeave() REPLACES an existing entry for the same host, never stacks', () => {
  let q = L.queueLeave([], A, 1000)
  q = L.queueLeave(q, A, 2000)
  assert.equal(q.length, 1, 'still one entry for that host')
  assert.equal(q[0].queuedAt, 2000, 'and it is the newer one')
})

test('queueLeave() keeps entries for OTHER hosts', () => {
  let q = L.queueLeave([], A, 1000)
  q = L.queueLeave(q, B, 1001)
  assert.deepEqual(q.map(e => e.hostKey).sort(), ['aaa', 'bbb'])
})

// The trap this exists to avoid: pair the host again, and a queued leave landing
// afterwards would revoke the grant the user had just created.
test('dropLeave() cancels a queued leave - what a RE-PAIR must do', () => {
  let q = L.queueLeave([], A, 1000)
  q = L.queueLeave(q, B, 1000)
  q = L.dropLeave(q, 'aaa')
  assert.deepEqual(q.map(e => e.hostKey), ['bbb'])
})

test('dropLeave() on an unknown host is a no-op', () => {
  const q = L.queueLeave([], A, 1000)
  assert.deepEqual(L.dropLeave(q, 'zzz'), q)
})

test('bumpAttempt() counts only the host it names', () => {
  let q = L.queueLeave([], A, 1000)
  q = L.queueLeave(q, B, 1000)
  q = L.bumpAttempt(q, 'aaa')
  assert.equal(q.find(e => e.hostKey === 'aaa').attempts, 1)
  assert.equal(q.find(e => e.hostKey === 'bbb').attempts, 0)
})

test('expire() drops entries past the age limit and keeps fresh ones', () => {
  let q = L.queueLeave([], A, 0)
  q = L.queueLeave(q, B, L.MAX_AGE_MS) // queued much later
  const kept = L.expire(q, L.MAX_AGE_MS + 1)
  assert.deepEqual(kept.map(e => e.hostKey), ['bbb'], 'the month-old entry is gone')
})

test('expire() gives up on an entry that has been retried too many times', () => {
  let q = L.queueLeave([], A, 1000)
  for (let i = 0; i < L.MAX_ATTEMPTS; i++) q = L.bumpAttempt(q, 'aaa')
  assert.deepEqual(L.expire(q, 1000), [], 'stops dialling a host that never answers')
})

test('normalize() tolerates junk on disk', () => {
  assert.deepEqual(L.normalize(null), [])
  assert.deepEqual(L.normalize('nope'), [])
  assert.deepEqual(L.normalize([null, { hostKey: 'a' }, { libraryId: 'b' }, A]).length, 1)
})
