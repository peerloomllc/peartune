// The shell's local-method reply, and the async ones it used to answer wrongly.
//
// app/index.tsx replied with the raw return value of `local[msg.method]()`, so an
// ASYNC method (play, enqueue, restore, switchQueue, playHere) was answered with a
// SERIALIZED PROMISE - `{"_h":0,"_i":0,...}` on Hermes - instead of its result.
// `call('restore').then(r => r?.restored)` in src/ui/App.jsx had therefore never once
// seen `restored`, on mount or on host:connected. The restore itself ran, which is why
// nothing looked broken (found 2026-08-29 while fixing the queue loss).
//
// index.tsx cannot be required from a node test (TSX, and it imports the native
// modules), so this does two things: it models the dispatch rule and asserts the
// behaviour, AND it greps the real file so the rule cannot quietly go back to what it
// was. The second half is the one that would catch a regression.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const shell = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.tsx'), 'utf8')

// The rule as it is now written in the shell.
async function dispatch (local, method) {
  const replies = []
  const reply = (payload) => { replies.push(payload); return payload }
  if (local[method]) {
    try {
      const result = await local[method]()
      return reply({ result: result ?? { ok: true } })
    } catch (e) {
      return reply({ error: e?.message || String(e) })
    }
  }
  return reply({ error: 'unknown method' })
}

test('an ASYNC method is answered with its result, not with a Promise', async () => {
  const local = {
    restore: async () => ({ restored: true, live: false, index: 3, queueLength: 12 })
  }
  const out = await dispatch(local, 'restore')
  assert.deepEqual(out, { result: { restored: true, live: false, index: 3, queueLength: 12 } })
  // The shape the bug produced: a thenable where the answer should be.
  assert.equal(typeof out.result.then, 'undefined', 'a Promise must never reach the UI')
})

test('a SYNC method is unchanged, including the ok:true default', async () => {
  const local = {
    theme: () => undefined,             // returns nothing
    queueMove: () => ({ items: [], index: 0 })
  }
  assert.deepEqual(await dispatch(local, 'theme'), { result: { ok: true } }, 'nothing returned still means ok')
  assert.deepEqual(await dispatch(local, 'queueMove'), { result: { items: [], index: 0 } })
})

test('a rejection becomes an error the UI can show, not an unhandled one', async () => {
  const local = { play: async () => { throw new Error('no such track') } }
  assert.deepEqual(await dispatch(local, 'play'), { error: 'no such track' })
  // A sync throw takes the same path.
  assert.deepEqual(await dispatch({ stop: () => { throw new Error('nope') } }, 'stop'), { error: 'nope' })
})

test('a falsy-but-real answer is not replaced by the ok:true default', async () => {
  // `?? { ok: true }` and not `|| { ok: true }`: a method answering false or 0 means
  // it, and the UI's `r?.restored` reads the object either way.
  const local = { restore: async () => ({ restored: false }) }
  assert.deepEqual(await dispatch(local, 'restore'), { result: { restored: false } })
})

// --- and the rule is really in the shell -------------------------------------

test('THE SHELL AWAITS its local methods before replying', () => {
  assert.match(shell, /const result = await local\[msg\.method\]\(\)/,
    'app/index.tsx must await the local method, or every async one answers with a Promise again')
  assert.ok(!/const result = local\[msg\.method\]\(\)\s*\n\s*return reply/.test(shell),
    'the un-awaited dispatch is back')
})

test('the methods this was about are still the async ones', () => {
  // If one of these stops being async the test above stops mattering for it; if a NEW
  // async one appears it is already covered, because the fix is at the dispatch.
  for (const name of ['play', 'enqueue', 'switchQueue', 'playHere']) {
    assert.match(shell, new RegExp(`async function ${name} ?\\(`), `${name} should still be async`)
  }
  assert.match(shell, /async function restoreQueue ?\(/)
})
