// The offline write-queue's coalescing logic. What is worth pinning: an older favorite
// write must not survive a newer one (LWW), a resume position keeps only the latest, and
// play counts must NOT be coalesced (each bump is a real, separate play).

const test = require('node:test')
const assert = require('node:assert/strict')
const { entryKey, coalesce, clientCall, OUTBOX_MAX } = require('../worklet/outbox')

const fav = (kind, id, on) => ({ method: 'fav.set', params: { kind, id, on } })
const resume = (trackId, positionMs) => ({ method: 'resume.set', params: { trackId, positionMs } })
const count = (trackId) => ({ method: 'count.bump', params: { trackId } })

test('a favorite write REPLACES an earlier one for the same target (LWW)', () => {
  let q = []
  q = coalesce(q, fav('track', 't1', true))
  q = coalesce(q, fav('track', 't1', false)) // changed my mind, still offline
  assert.equal(q.length, 1, 'only the latest survives')
  assert.equal(q[0].params.on, false)
})

test('different favorite targets are kept independently', () => {
  let q = []
  q = coalesce(q, fav('track', 't1', true))
  q = coalesce(q, fav('album', 't1', true)) // same id, different KIND
  q = coalesce(q, fav('track', 't2', true))
  assert.deepEqual(q.map(entryKey), ['fav:track:t1', 'fav:album:t1', 'fav:track:t2'])
})

test('a resume position keeps only the latest per track', () => {
  let q = []
  q = coalesce(q, resume('t1', 1000))
  q = coalesce(q, resume('t1', 2000))
  q = coalesce(q, resume('t2', 500))
  assert.equal(q.filter(e => e.params.trackId === 't1').length, 1)
  assert.equal(q.find(e => e.params.trackId === 't1').params.positionMs, 2000)
  assert.equal(q.length, 2)
})

test('play counts ACCUMULATE - two bumps of the same track are two plays', () => {
  let q = []
  q = coalesce(q, count('t1'))
  q = coalesce(q, count('t1'))
  q = coalesce(q, count('t2'))
  assert.equal(q.length, 3, 'no coalescing of counts')
  assert.equal(q.filter(e => e.params.trackId === 't1').length, 2)
})

test('order across different targets is preserved (replay is in order)', () => {
  let q = []
  q = coalesce(q, fav('track', 'a', true))
  q = coalesce(q, resume('b', 100))
  q = coalesce(q, count('c'))
  assert.deepEqual(q.map(e => e.method), ['fav.set', 'resume.set', 'count.bump'])
})

test('the queue is capped (oldest out) so a long offline stretch cannot grow forever', () => {
  let q = []
  for (let i = 0; i < OUTBOX_MAX + 25; i++) q = coalesce(q, count('t' + i))
  assert.equal(q.length, OUTBOX_MAX)
  // The most recent survive; the oldest 25 fell off.
  assert.equal(q[q.length - 1].params.trackId, 't' + (OUTBOX_MAX + 24))
  assert.equal(q[0].params.trackId, 't25')
})

test('clientCall maps each entry to its client method; unknown -> null', () => {
  const calls = []
  const client = {
    favSet: (p) => { calls.push(['favSet', p]); return 'f' },
    resumeSet: (p) => { calls.push(['resumeSet', p]); return 'r' },
    countBump: (p) => { calls.push(['countBump', p]); return 'c' }
  }
  assert.equal(clientCall(client, fav('track', 't1', true))(), 'f')
  assert.equal(clientCall(client, resume('t1', 1))(), 'r')
  assert.equal(clientCall(client, count('t1'))(), 'c')
  assert.equal(clientCall(client, { method: 'who.knows', params: {} }), null)
  assert.deepEqual(calls.map(c => c[0]), ['favSet', 'resumeSet', 'countBump'])
})
