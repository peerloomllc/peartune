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
  // It really is a single file inside the dir, not a nested path escape. index.json is the
  // store's own index (added with size-keying, proposal 2026-07-29-persist-album-art), so
  // count the BLOBS rather than the directory.
  assert.deepEqual(fs.readdirSync(d).filter((f) => f !== 'index.json').length, 1)
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

// --- size-keying, attribution and the cap (proposal 2026-07-29-persist-album-art) --------
//
// The bug all of this exists for: art was keyed by coverId ALONE, so one stored image could
// not answer a request for another size, so the shim's disk read had to be pinned to
// DEFAULT_ART_SIZE. The library grid asks for 120/350/500 depending on density, so grid art
// never came off disk at all - even for a downloaded album - and every cold start re-fetched
// every visible cover. Over a relayed connection that is bandwidth PeerLoom pays for, spent
// again and again on bytes that never change.

const { DEFAULT_SIZE } = require('../worklet/art-cache')

test('the default size matches the shim, so the duplicated constant cannot drift', () => {
  // art-cache deliberately does NOT import shim.js - it pulls bare-http1, a native addon that
  // only exists on the phone, which would make this module unloadable here. So the constant is
  // duplicated, and this is what stops that becoming a silent bug: a store defaulting to a
  // size the shim never asks for would make every single disk read miss.
  const shim = fs.readFileSync(path.join(__dirname, '..', 'worklet', 'shim.js'), 'utf8')
  const m = shim.match(/const DEFAULT_ART_SIZE = (\d+)/)
  assert.ok(m, 'shim.js still declares DEFAULT_ART_SIZE')
  assert.equal(Number(m[1]), DEFAULT_SIZE)
})

test('SIZES ARE SEPARATE ENTRIES - the actual bug', async (t) => {
  const store = new ArtStore({ dir: await dir(t) })
  assert.equal(store.put('cov', buf('SMALL'), { size: 300 }), true)
  assert.equal(store.put('cov', buf('BIGGER!'), { size: 500 }), true)

  assert.deepEqual(store.get('cov', 300), buf('SMALL'))
  assert.deepEqual(store.get('cov', 500), buf('BIGGER!'))
  // The old store held ONE file here and answered both requests with the same bytes.
  assert.equal(store.count(), 2)
  // A size never stored is a MISS, not a wrong-size hit - which is precisely why the one-size
  // restriction had to exist before this.
  assert.equal(store.get('cov', 120), null)
  assert.equal(store.has('cov', 120), false)
})

test('the default size is implied, so existing callers keep working unchanged', async (t) => {
  // The pin path and the demo installer call put(id, buf) / has(id) / get(id) with no size.
  // They must land on DEFAULT_SIZE, not write an "undefined" key.
  const store = new ArtStore({ dir: await dir(t) })
  assert.equal(store.put('cov', buf('X')), true)
  assert.equal(store.has('cov'), true)
  assert.equal(store.has('cov', DEFAULT_SIZE), true)
  assert.deepEqual(store.get('cov'), buf('X'))
})

test('remove() drops EVERY size of a cover', async (t) => {
  const store = new ArtStore({ dir: await dir(t) })
  store.put('cov', buf('A'), { size: 120 })
  store.put('cov', buf('B'), { size: 300 })
  store.put('other', buf('C'), { size: 300 })
  store.remove('cov')
  assert.equal(store.has('cov', 120), false)
  assert.equal(store.has('cov', 300), false)
  assert.equal(store.has('other', 300), true, 'an unrelated cover survives')
})

test('removeLibrary reclaims ONE library and leaves the others alone', async (t) => {
  const store = new ArtStore({ dir: await dir(t) })
  store.put('a', buf('aa'), { library: 'lib1' })
  store.put('b', buf('bbbb'), { library: 'lib1', size: 500 })
  store.put('c', buf('cccccc'), { library: 'lib2' })

  const r = store.removeLibrary('lib1')
  assert.equal(r.removed, 2)
  assert.equal(r.bytes, 6)
  assert.equal(store.has('a'), false)
  assert.equal(store.has('b', 500), false)
  assert.equal(store.has('c'), true, "lib2's art is untouched")
})

test('untagged rows are REPORTED, never guessed at', async (t) => {
  // Entries written before the library tag existed have library:null. Claiming them for
  // whichever library is being removed would delete a different library's art, so they are
  // left to the cap - and the count comes back so the caller can say so in the log honestly.
  const store = new ArtStore({ dir: await dir(t) })
  store.put('old', buf('O'))                       // no library
  store.put('new', buf('N'), { library: 'lib1' })
  const r = store.removeLibrary('lib1')
  assert.equal(r.removed, 1)
  assert.equal(r.untagged, 1)
  assert.equal(store.has('old'), true, 'the untagged row survives')
})

test('removeLibrary with no libraryId is a no-op, not a wipe', async (t) => {
  const store = new ArtStore({ dir: await dir(t) })
  store.put('a', buf('A'), { library: 'lib1' })
  assert.deepEqual(store.removeLibrary(null), { removed: 0, bytes: 0, untagged: 0 })
  assert.equal(store.has('a'), true)
})

test('the count cap evicts least-recently-USED and never a pinned cover', async (t) => {
  const store = new ArtStore({ dir: await dir(t), maxEntries: 3 })
  store.put('pinned', buf('P'), { pinned: true })
  store.put('old', buf('O'))
  store.put('mid', buf('M'))
  // Reading must count as use, or a cover scrolled past daily would be evicted ahead of one
  // fetched once and never looked at again.
  store.get('old')
  store.put('newest', buf('N'))   // 4 entries against a cap of 3

  assert.equal(store.count(), 3)
  assert.equal(store.has('pinned'), true, 'a downloaded album cover is never evicted')
  assert.equal(store.has('mid'), false, 'the least recently used unpinned entry went')
  assert.equal(store.has('old'), true)
  assert.equal(store.has('newest'), true)
})

test('a cap smaller than the pinned set stops caching rather than evicting downloads', async (t) => {
  // Degrades to the OLD behaviour (nothing new cached) instead of breaking offline artwork.
  const store = new ArtStore({ dir: await dir(t), maxEntries: 1 })
  store.put('p1', buf('1'), { pinned: true })
  store.put('p2', buf('2'), { pinned: true })
  store.put('browse', buf('B'))
  assert.equal(store.has('p1'), true)
  assert.equal(store.has('p2'), true)
  assert.equal(store.has('browse'), false)
})

test('setPinned protects a cover browsing already fetched, with no second download', async (t) => {
  const store = new ArtStore({ dir: await dir(t), maxEntries: 1 })
  store.put('cov', buf('C'))               // fetched by BROWSING, unpinned
  assert.equal(store.setPinned('cov', true), true)
  store.put('filler', buf('F'))            // would evict the LRU entry
  assert.equal(store.has('cov'), true, 'pinning what is already there is enough')
})

test('an indexed file that has vanished is dropped, not served as nothing', async (t) => {
  const d = await dir(t)
  const store = new ArtStore({ dir: d })
  store.put('cov', buf('C'))
  for (const f of fs.readdirSync(d)) {
    if (f !== 'index.json') fs.unlinkSync(path.join(d, f))
  }
  assert.equal(store.get('cov'), null)
  assert.equal(store.has('cov'), false, 'the stale row is gone, so the next request re-fetches')
})

test('the index survives a restart, library tag and all', async (t) => {
  const d = await dir(t)
  new ArtStore({ dir: d }).put('cov', buf('PERSISTED'), { size: 500, library: 'lib1', pinned: true })

  const reopened = new ArtStore({ dir: d })
  assert.equal(reopened.has('cov', 500), true)
  assert.deepEqual(reopened.get('cov', 500), buf('PERSISTED'))
  assert.equal(reopened.removeLibrary('lib1').removed, 1, 'the library tag persisted too')
})

test('sweepLegacy removes size-less files and keeps size-keyed ones', async (t) => {
  const d = await dir(t)
  const store = new ArtStore({ dir: d })
  store.put('keep', buf('K'), { size: 300 })
  // A pre-change file: encodeURIComponent(coverId) with no "@<size>" suffix. Nothing will
  // ever read it again, so it is pure dead weight.
  fs.writeFileSync(path.join(d, 'legacycover'), buf('OLD'))

  assert.equal(store.sweepLegacy(), 1)
  assert.equal(fs.existsSync(path.join(d, 'legacycover')), false)
  assert.equal(store.has('keep', 300), true)
  assert.ok(fs.existsSync(path.join(d, 'index.json')), 'the index is not swept')
})

test('sweepLegacy on a never-written dir does not throw', async (t) => {
  const store = new ArtStore({ dir: path.join(await dir(t), 'never') })
  assert.equal(store.sweepLegacy(), 0)
})

test('a slashed coverId still matches for setPinned and remove', async (t) => {
  // Ids come from a source server and are not guaranteed filename-safe. The key is
  // encodeURIComponent'd, so the point here is that decoding back OUT still matches.
  const store = new ArtStore({ dir: await dir(t) })
  const id = 'al/bum art #1'
  store.put(id, buf('IMG'), { size: 350 })
  assert.equal(store.has(id, 350), true)
  assert.equal(store.setPinned(id, true), true)
  store.remove(id)
  assert.equal(store.has(id, 350), false)
})

test('get() does not rewrite the index, but ordering still holds', async (t) => {
  // get() is the hottest path - a grid re-render asks for dozens of covers - so persisting the
  // whole index on every read was pure write amplification. Ordering is kept in memory and
  // flushed by the next write, which is enough because LRU order is an optimisation, not
  // correctness.
  const d = await dir(t)
  const store = new ArtStore({ dir: d, maxEntries: 2 })
  store.put('a', buf('A'))
  store.put('b', buf('B'))

  const before = fs.statSync(path.join(d, 'index.json')).mtimeMs
  store.get('a')                       // touch 'a' so 'b' becomes the LRU victim
  const after = fs.statSync(path.join(d, 'index.json')).mtimeMs
  assert.equal(after, before, 'a read must not rewrite the index')

  store.put('c', buf('C'))             // over the cap - evicts the least recently used
  assert.equal(store.has('a'), true, 'the un-persisted touch still ordered the eviction')
  assert.equal(store.has('b'), false)
  assert.equal(store.has('c'), true)
})

test('flush() persists pending touches for a caller that needs them durable', async (t) => {
  const d = await dir(t)
  const store = new ArtStore({ dir: d })
  store.put('a', buf('A'))
  store.put('b', buf('B'))
  store.get('a')
  store.flush()

  // A fresh instance must see 'a' as more recently used than 'b'. Cap of 2, not 1: with three
  // entries against a cap of 1 it would evict TWO and prove nothing about the ordering.
  const reopened = new ArtStore({ dir: d, maxEntries: 2 })
  reopened.put('c', buf('C'))
  assert.equal(reopened.has('b'), false, 'the older entry went')
  assert.equal(reopened.has('a'), true, 'the flushed touch survived the restart')
})
