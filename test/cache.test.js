// The on-disk audio cache. The pure eviction math is pinned directly; the class is
// exercised against a real temp dir (bare-fs is Node-fs-compatible, so this covers the
// worklet's real behavior: write-through commit, range reads, LRU eviction, clear).

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

const { AudioCache, evictionPlan } = require('../worklet/cache')

async function dir (t) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-cache-'))
  t.after(() => fsp.rm(d, { recursive: true, force: true }))
  return d
}

// Stream a whole "track" through a sink and commit it.
async function put (cache, id, bytes, mime = 'audio/flac') {
  const sink = cache.createSink(id, { mime, size: bytes.length })
  sink.write(bytes)
  return sink.commit()
}

// --- pure eviction plan ------------------------------------------------------

test('evictionPlan: nothing to do under the cap or when unlimited', () => {
  const idx = { a: { size: 10, lastPlayed: 1 }, b: { size: 10, lastPlayed: 2 } }
  assert.deepEqual(evictionPlan(idx, 100), [])
  assert.deepEqual(evictionPlan(idx, 0), [], 'cap 0 = unlimited')
})

test('evictionPlan drops the OLDEST-played first, until under the cap', () => {
  const idx = {
    old: { size: 30, lastPlayed: 1 },
    mid: { size: 30, lastPlayed: 2 },
    new: { size: 30, lastPlayed: 3 }
  }
  // cap 70: total 90 -> must drop 20+; the oldest (old, 30) alone brings it to 60.
  assert.deepEqual(evictionPlan(idx, 70), ['old'])
  // cap 50: drop old then mid (60 -> 30).
  assert.deepEqual(evictionPlan(idx, 50), ['old', 'mid'])
})

test('evictionPlan never evicts pinned, and pinned does not count toward the cap', () => {
  const idx = {
    pin: { size: 100, lastPlayed: 1, pinned: true },
    lruOld: { size: 30, lastPlayed: 2 },
    lruNew: { size: 30, lastPlayed: 3 }
  }
  // The LRU bucket is 60; under a cap of 40 only the oldest LRU evicts. Pinned's 100 is
  // ignored entirely.
  assert.deepEqual(evictionPlan(idx, 40), ['lruOld'])
})

// --- the class against a real dir --------------------------------------------

test('a committed track is has()-able, sized, and reads back byte-for-byte', async (t) => {
  const cache = new AudioCache({ dir: await dir(t) })
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256))
  assert.equal(await put(cache, 'track-1', bytes), true)
  assert.equal(cache.has('track-1'), true)
  assert.equal(cache.get('track-1').size, 5000)
  assert.equal(cache.totalBytes(), 5000)

  const got = await streamToBuffer(cache.readStream('track-1', 0, 4999))
  assert.ok(got.equals(bytes), 'full read matches')
  const mid = await streamToBuffer(cache.readStream('track-1', 1000, 1099))
  assert.ok(mid.equals(bytes.subarray(1000, 1100)), 'a range read matches (seeking works from disk)')
})

test('a short read is NOT committed (a skip mid-download must not store a partial as whole)', async (t) => {
  const cache = new AudioCache({ dir: await dir(t) })
  const sink = cache.createSink('track-x', { mime: 'audio/flac', size: 1000 })
  sink.write(Buffer.alloc(400)) // only part arrived
  assert.equal(await sink.commit(), false)
  assert.equal(cache.has('track-x'), false, 'nothing stored')
})

test('an aborted sink leaves no file and no index entry', async (t) => {
  const cache = new AudioCache({ dir: await dir(t) })
  const sink = cache.createSink('track-y', { mime: 'audio/flac', size: 1000 })
  sink.write(Buffer.alloc(500))
  sink.abort()
  assert.equal(cache.has('track-y'), false)
})

test('committing over the cap evicts the oldest, and the file is really gone', async (t) => {
  const d = await dir(t)
  const cache = new AudioCache({ dir: d, cap: 2500 })
  await put(cache, 'a', Buffer.alloc(1000)); cache.touch('a')
  await put(cache, 'b', Buffer.alloc(1000))
  await put(cache, 'c', Buffer.alloc(1000)) // total 3000 > 2500 -> evict oldest (a)

  assert.equal(cache.has('a'), false, 'oldest evicted')
  assert.equal(cache.has('b'), true)
  assert.equal(cache.has('c'), true)
  assert.equal(fs.existsSync(path.join(d, 'a')), false, 'the file itself is deleted')
  assert.ok(cache.totalBytes() <= 2500)
})

test('the index survives a reopen (it is on disk)', async (t) => {
  const d = await dir(t)
  const c1 = new AudioCache({ dir: d })
  await put(c1, 'keep', Buffer.alloc(2048))
  const c2 = new AudioCache({ dir: d })
  assert.equal(c2.has('keep'), true)
  assert.equal(c2.get('keep').size, 2048)
})

test('clear() empties the index and deletes every file (the purge primitive)', async (t) => {
  const d = await dir(t)
  const cache = new AudioCache({ dir: d })
  await put(cache, 'a', Buffer.alloc(100))
  await put(cache, 'b', Buffer.alloc(100))
  cache.clear()
  assert.equal(cache.count(), 0)
  assert.equal(cache.totalBytes(), 0)
  assert.equal(fs.existsSync(path.join(d, 'a')), false)
  assert.equal(fs.existsSync(path.join(d, 'b')), false)
})

function streamToBuffer (rs) {
  return new Promise((resolve, reject) => {
    const chunks = []
    rs.on('data', (c) => chunks.push(c))
    rs.on('end', () => resolve(Buffer.concat(chunks)))
    rs.on('error', reject)
  })
}
