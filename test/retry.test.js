// The reconnect backoff. Two loops depend on it now - the active client and every pool host in
// a blend - and both failure modes it guards against are real: too fast is a dial every few
// seconds at a host that is simply off, too slow is a library that stays dark long after the
// network came back.

const test = require('node:test')
const assert = require('node:assert/strict')

const { nextDelay, ladder, MIN_MS, MAX_MS } = require('../worklet/retry')

test('the first retry waits the minimum, not zero', () => {
  assert.equal(nextDelay(0), MIN_MS)
  assert.equal(nextDelay(), MIN_MS, 'no argument means "no previous attempt"')
})

test('it doubles, then holds at the ceiling forever', () => {
  assert.deepEqual(ladder(6), [5000, 10000, 20000, 40000, 60000, 60000])
  assert.equal(nextDelay(MAX_MS), MAX_MS, 'already at the cap: stay there')
  assert.equal(nextDelay(MAX_MS * 10), MAX_MS, 'and never exceed it, whatever came in')
})

test('a garbage previous delay restarts the ladder instead of propagating', () => {
  // These would otherwise become a hammering retry (0 / negative) or one that never fires
  // (NaN / Infinity), and both would arrive via a caller's error path where nobody is looking.
  for (const bad of [null, undefined, NaN, -1, -Infinity, Infinity, 'soon']) {
    assert.equal(nextDelay(bad), MIN_MS, `bad input ${String(bad)} falls back to the minimum`)
  }
})

test('the bounds are configurable, and a nonsense range still yields a sane wait', () => {
  assert.deepEqual(ladder(4, { min: 1000, max: 4000 }), [1000, 2000, 4000, 4000])
  assert.equal(nextDelay(0, { min: 0 }), MIN_MS, 'a zero minimum would be a busy loop')
  assert.equal(nextDelay(0, { min: -5 }), MIN_MS)
  // A max BELOW min is contradictory, so it is ignored and the ladder carries on under the
  // default ceiling. What must never happen is the wait collapsing to the tiny "max".
  assert.equal(nextDelay(5000, { min: 5000, max: 100 }), 10000)
  assert.ok(nextDelay(5000, { min: 5000, max: 100 }) >= 5000, 'never shorter than the minimum')
})
