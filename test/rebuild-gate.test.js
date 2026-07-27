// The merged-index rebuild gate.
//
// The bug this pins (found reading the pool-reliability path, 2026-07-26): a rebuild is
// requested BECAUSE a host just joined the blend, but a plain single-flight answered that
// request with the build already in flight - which took its host list before that host
// connected, so it could not possibly contain it. The library then stayed missing from All
// libraries with no further rebuild queued: connected, chip lit, tracks absent.

const test = require('node:test')
const assert = require('node:assert/strict')

const { createRebuildGate } = require('../worklet/rebuild-gate')

const defer = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setImmediate(r))

test('a request made DURING a build gets a follow-up build', async () => {
  const gates = [defer(), defer()]
  let runs = 0
  const gate = createRebuildGate(() => gates[runs++].promise)

  const first = gate.request()
  await tick()
  assert.equal(runs, 1)

  gate.request() // a host joined mid-build - the whole point
  gates[0].resolve('build-1')
  await first
  await tick()

  assert.equal(runs, 2, 'the mid-build request must be re-run, not answered by the stale build')
  gates[1].resolve('build-2')
})

test('many mid-build requests coalesce into ONE follow-up', async () => {
  const gates = [defer(), defer(), defer()]
  let runs = 0
  const gate = createRebuildGate(() => gates[runs++].promise)

  const first = gate.request()
  await tick()
  for (let i = 0; i < 5; i++) gate.request()
  gates[0].resolve()
  await first
  await tick()

  assert.equal(runs, 2, 'five hosts joining during one build cost one rebuild, not five')
  gates[1].resolve()
  await tick()
  assert.equal(runs, 2, 'and the follow-up does not queue a third by itself')
})

test('sequential requests each run - the gate is not a lock', async () => {
  let runs = 0
  const gate = createRebuildGate(async () => { runs++ })
  await gate.request()
  await gate.request()
  assert.equal(runs, 2)
})

test('concurrent requests share the in-flight promise', async () => {
  const d = defer()
  let runs = 0
  const gate = createRebuildGate(() => { runs++; return d.promise })
  const a = gate.request()
  const b = gate.request()
  assert.equal(a, b, 'the second caller waits on the build already running')
  assert.equal(runs, 1)
  d.resolve()
  await a
  await tick()
})

test('a failed build clears the gate, so the next request still builds', async () => {
  let runs = 0
  const gate = createRebuildGate(async () => {
    runs++
    if (runs === 1) throw new Error('host dropped mid-fetch')
  })
  await assert.rejects(gate.request())
  await gate.request()
  assert.equal(runs, 2, 'a build that threw must not wedge the gate shut')
})

test('a follow-up that fails does not reject into nowhere', async () => {
  // The follow-up has no caller to catch it. If it rejected unhandled it would take the
  // worklet down on Bare, where an unhandled rejection is fatal.
  const first = defer()
  let runs = 0
  const gate = createRebuildGate(() => {
    runs++
    return runs === 1 ? first.promise : Promise.reject(new Error('still offline'))
  })
  const p = gate.request()
  gate.request()
  first.resolve()
  await p
  await tick()
  await tick()
  assert.equal(runs, 2)
})

test('busy and pending report the gate state', async () => {
  const d = defer()
  const gate = createRebuildGate(() => d.promise)
  assert.equal(gate.busy, false)
  const p = gate.request()
  assert.equal(gate.busy, true)
  assert.equal(gate.pending, false)
  gate.request()
  assert.equal(gate.pending, true)
  d.resolve()
  await p
  await tick()
})
