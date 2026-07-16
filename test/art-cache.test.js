// The persistent album-art store. Exercised against a real temp dir (bare-fs is
// Node-fs-compatible), covering the round-trip that makes a downloaded album show its
// real cover offline, plus the edge cases the shim/pin flow rely on.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

const { ArtStore } = require('../worklet/art-cache')

async function dir (t) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-art-'))
  t.after(() => fsp.rm(d, { recursive: true, force: true }))
  return d
}

const buf = (s) => Buffer.from(s)

test('put then get round-trips the image bytes', async (t) => {
  const store = new ArtStore({ dir: await dir(t) })
  assert.equal(store.has('cover-1'), false)
  assert.equal(store.put('cover-1', buf('JPEGDATA')), true)
  assert.equal(store.has('cover-1'), true)
  assert.deepEqual(store.get('cover-1'), buf('JPEGDATA'))
})

test('a missing cover reads as absent, not an error', async (t) => {
  const store = new ArtStore({ dir: await dir(t) })
  assert.equal(store.has('nope'), false)
  assert.equal(store.get('nope'), null)
})

test('put is a no-op for a falsy coverId or an empty buffer', async (t) => {
  const store = new ArtStore({ dir: await dir(t) })
  assert.equal(store.put('', buf('x')), false)
  assert.equal(store.put(null, buf('x')), false)
  assert.equal(store.put('cover', buf('')), false)
  assert.equal(store.put('cover', null), false)
  assert.equal(store.has('cover'), false)
})

test('has/get tolerate a falsy coverId', async (t) => {
  const store = new ArtStore({ dir: await dir(t) })
  assert.equal(store.has(null), false)
  assert.equal(store.get(null), null)
})

test('coverIds with slashes are stored safely (encoded to one filename)', async (t) => {
  const d = await dir(t)
  const store = new ArtStore({ dir: d })
  const id = 'al/bum/../weird?id'
  assert.equal(store.put(id, buf('IMG')), true)
  assert.deepEqual(store.get(id), buf('IMG'))
  // It really is a single file inside the dir, not a nested path escape.
  assert.equal(fs.readdirSync(d).length, 1)
})

test('remove deletes one cover and leaves the rest', async (t) => {
  const store = new ArtStore({ dir: await dir(t) })
  store.put('a', buf('A')); store.put('b', buf('B'))
  store.remove('a')
  assert.equal(store.has('a'), false)
  assert.equal(store.has('b'), true)
  // removing a missing cover is harmless
  store.remove('a'); store.remove('nope')
})

test('clear empties the whole store', async (t) => {
  const store = new ArtStore({ dir: await dir(t) })
  store.put('a', buf('A')); store.put('b', buf('B'))
  store.clear()
  assert.equal(store.has('a'), false)
  assert.equal(store.has('b'), false)
})

test('clear on a never-written dir does not throw', async (t) => {
  const store = new ArtStore({ dir: path.join(await dir(t), 'never') })
  store.clear() // no dir yet
  assert.equal(store.has('a'), false)
})

test('put survives a fresh instance on the same dir (persistence)', async (t) => {
  const d = await dir(t)
  new ArtStore({ dir: d }).put('cover', buf('PERSISTED'))
  const reopened = new ArtStore({ dir: d })
  assert.deepEqual(reopened.get('cover'), buf('PERSISTED'))
})
