// The demo library (proposal 2026-07-28-app-review-demo): five CC0 tracks shipped in
// the app, browsable and playable with no host.
//
// Two halves, both testable here: the pure manifest -> catalog build (checked against a
// hand-written manifest, no files needed), and the install, which is checked against a
// REAL AudioCache and ArtStore over a temp dir - because the whole point of the design
// is that a demo track is an ordinary pinned cache entry, and that claim is only worth
// anything if the real cache agrees.
//
// The last test loads the SHIPPED manifest, so a bad edit to assets/demo-music/ fails
// the gate rather than the phone.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

const {
  DEMO_LIBRARY_ID,
  DEMO_LIBRARY_NAME,
  statDemoFiles,
  buildDemoCatalog,
  demoStats,
  installDemoMedia,
  removeDemoMedia
} = require('../worklet/demo')
const { AudioCache } = require('../worklet/cache')
const { ArtStore } = require('../worklet/art-cache')
const catalog = require('../worklet/catalog')

const MANIFEST = {
  album: 'LOFI AMBIENT SONGS !',
  artist: 'Loyalty Freak Music',
  year: 2021,
  genre: 'Lo-Fi',
  cover: 'cover.jpg',
  tracks: [
    { file: 'b.mp3', title: 'Second', track: 2, durationMs: 2000 },
    { file: 'a.mp3', title: 'First', track: 1, durationMs: 1000 },
    { file: 'c.mp3', title: 'Third', track: 3, durationMs: 3000 }
  ]
}

async function dir (t) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-demo-'))
  t.after(() => fsp.rm(d, { recursive: true, force: true }))
  return d
}

// A temp dir of fake "bundled assets" + the { name -> path } map the shell hands over.
async function bundle (t, names, bytes = 4096) {
  const d = await dir(t)
  const files = {}
  for (const n of names) {
    const p = path.join(d, n)
    fs.writeFileSync(p, Buffer.alloc(bytes, n.charCodeAt(0)))
    files[n] = p
  }
  return { d, files }
}

test('the catalog builds one album, one artist and the tracks in disc/track order', () => {
  const c = buildDemoCatalog(MANIFEST)

  assert.equal(c.libraryId, DEMO_LIBRARY_ID)
  assert.equal(c.name, DEMO_LIBRARY_NAME)
  assert.equal(c.albums.length, 1)
  assert.equal(c.artists.length, 1)
  assert.equal(c.tracks.length, 3)

  // Ordered by track number, NOT by manifest order - the manifest deliberately lists
  // them 2, 1, 3 above.
  assert.deepEqual(c.tracks.map((t) => t.title), ['First', 'Second', 'Third'])

  assert.equal(c.album.name, 'LOFI AMBIENT SONGS !')
  assert.equal(c.album.artist, 'Loyalty Freak Music')
  assert.equal(c.album.songCount, 3)
  assert.equal(c.artist.name, 'Loyalty Freak Music')
  assert.equal(c.artist.albumCount, 1)
})

test('every entity carries the shapes the browse methods already serve', () => {
  const c = buildDemoCatalog(MANIFEST)
  const t = c.tracks[0]

  // The folder adapter's track projection, field for field - anything missing here is
  // a blank line in the UI.
  for (const k of ['id', 'title', 'artist', 'album', 'albumId', 'artistId', 'track', 'year', 'durationMs', 'coverId', 'suffix', 'path']) {
    assert.ok(k in t, `track is missing ${k}`)
  }
  assert.equal(t.album, 'LOFI AMBIENT SONGS !')
  assert.equal(t.artist, 'Loyalty Freak Music')
  assert.equal(t.albumId, c.album.id)
  assert.equal(t.artistId, c.artist.id)
  assert.equal(t.suffix, 'mp3')

  // The cover is the album's own id, exactly as a folder library resolves artwork -
  // so shim.serveArt finds it in the art store with no special case.
  assert.equal(c.album.coverId, c.album.id)
  assert.equal(t.coverId, c.album.id)
  assert.equal(c.artist.coverId, c.album.id)
})

test('ids are stable z32, library-scoped, and unique per track', () => {
  const a = buildDemoCatalog(MANIFEST)
  const b = buildDemoCatalog(MANIFEST)

  // Deterministic across builds: a re-launch must find its cached bytes, not re-copy
  // 18 MB under fresh ids.
  assert.deepEqual(a.tracks.map((t) => t.id), b.tracks.map((t) => t.id))
  assert.equal(a.album.id, b.album.id)

  const ids = [...a.tracks.map((t) => t.id), a.album.id, a.artist.id]
  assert.equal(new Set(ids).size, ids.length, 'ids collide')
  // The shim's URL router only matches lowercase alnum, so a non-z32 id would 404 on
  // every play. z32 has no upper case and no punctuation.
  for (const id of ids) assert.match(id, /^[a-z0-9]+$/)
})

test('a track id follows the FILE NAME, not the tags', () => {
  const renamed = { ...MANIFEST, tracks: MANIFEST.tracks.map((t) => ({ ...t, title: t.title + ' (remaster)' })) }
  const a = buildDemoCatalog(MANIFEST)
  const b = buildDemoCatalog(renamed)
  assert.deepEqual(a.tracks.map((t) => t.id), b.tracks.map((t) => t.id))

  const moved = { ...MANIFEST, tracks: MANIFEST.tracks.map((t) => ({ ...t, file: 'x-' + t.file })) }
  const c = buildDemoCatalog(moved)
  assert.notDeepEqual(a.tracks.map((t) => t.id), c.tracks.map((t) => t.id))
})

test('genres come from the tags, and no tag means no genre rather than an invented one', () => {
  const withGenre = buildDemoCatalog(MANIFEST)
  assert.equal(withGenre.genres.length, 1)
  assert.equal(withGenre.genres[0].name, 'Lo-Fi')
  assert.equal(withGenre.genres[0].albumCount, 1)
  assert.equal(withGenre.tracks[0].genre, 'Lo-Fi')

  const { genre, ...noGenre } = MANIFEST
  assert.deepEqual(buildDemoCatalog(noGenre).genres, [])
})

test('an empty or malformed manifest degrades instead of throwing', () => {
  for (const m of [null, {}, { tracks: null }, { tracks: [] }]) {
    const c = buildDemoCatalog(m)
    assert.equal(c.tracks.length, 0)
    assert.equal(c.albums.length, 1) // still one (empty) album, so browse has something to answer
    assert.equal(c.album.songCount, 0)
  }
})

test('the merged browse helpers serve the demo catalog unchanged', () => {
  // This is the load-bearing claim of the design: demo mode is a third branch beside
  // merged mode, reusing the SAME in-memory list/search helpers.
  const c = buildDemoCatalog(MANIFEST)

  const page = catalog.serveList(c.tracks, { sort: 'title', order: 'asc', cursor: 0, limit: 2 })
  assert.deepEqual(page.items.map((t) => t.title), ['First', 'Second'])
  assert.equal(page.nextCursor, 2)

  const rest = catalog.serveList(c.tracks, { sort: 'title', cursor: 2, limit: 2 })
  assert.deepEqual(rest.items.map((t) => t.title), ['Third'])
  assert.equal(rest.nextCursor, null)

  const hits = catalog.searchIndex(c, 'loyalty')
  assert.equal(hits.artists.length, 1)
  assert.equal(hits.albums.length, 1)
  assert.equal(catalog.searchIndex(c, 'second').tracks.length, 1)
  assert.deepEqual(catalog.searchIndex(c, 'nothing here').tracks, [])
})

test('stats report the demo library, and say so', () => {
  const s = demoStats(buildDemoCatalog(MANIFEST))
  assert.equal(s.demo, true)
  assert.equal(s.sourceName, DEMO_LIBRARY_NAME)
  assert.equal(s.tracks, 3)
  assert.equal(s.albums, 1)
  assert.equal(s.artists, 1)
  assert.equal(s.genres, 1)
  assert.ok(s.sorts.tracks.keys.includes('title'))
})

test('statDemoFiles reads sizes and dates, and survives a missing file', async (t) => {
  const { d, files } = await bundle(t, ['a.mp3', 'b.mp3'], 1234)
  files['gone.mp3'] = path.join(d, 'gone.mp3')

  const stats = statDemoFiles(files)
  assert.equal(stats['a.mp3'].size, 1234)
  assert.ok(stats['a.mp3'].addedAt > 0)
  assert.equal(stats['gone.mp3'].size, 0)
  assert.equal(stats['gone.mp3'].addedAt, null)

  const c = buildDemoCatalog(MANIFEST, { stats })
  assert.equal(c.tracks.find((x) => x.path === 'a.mp3').size, 1234)
  assert.equal(c.tracks.find((x) => x.path === 'c.mp3').size, null)
})

test('install puts the tracks in the audio cache PINNED, and the cover in the art store', async (t) => {
  const { files } = await bundle(t, ['a.mp3', 'b.mp3', 'c.mp3', 'cover.jpg'], 2048)
  const cover = files['cover.jpg']
  const cacheDir = await dir(t)
  const artDir = await dir(t)
  // A tiny cap on purpose: pinned entries must not count toward it, so nothing here
  // may be evicted however small it is.
  const cache = new AudioCache({ dir: cacheDir, cap: 1024 })
  const artStore = new ArtStore({ dir: artDir })

  const c = buildDemoCatalog(MANIFEST, { stats: statDemoFiles(files) })
  const r = await installDemoMedia({ catalog: c, files, cover, cache, artStore })

  assert.equal(r.installed, 3)
  assert.equal(r.failed, 0)
  assert.equal(r.art, true)

  for (const track of c.tracks) {
    assert.ok(cache.has(track.id), 'not cached')
    assert.ok(cache.isPinned(track.id), 'not pinned - the LRU would eat it')
    assert.equal(cache.get(track.id).size, 2048)
    assert.equal(cache.get(track.id).mime, 'audio/mpeg')
    assert.equal(cache.get(track.id).library, DEMO_LIBRARY_ID)
  }
  assert.ok(artStore.has(c.album.coverId))
  assert.equal(artStore.get(c.album.coverId).length, 2048)
})

test('installed bytes read back byte-for-byte through the cache read path', async (t) => {
  const { files } = await bundle(t, ['a.mp3', 'b.mp3', 'c.mp3'], 5000)
  const cache = new AudioCache({ dir: await dir(t), cap: 0 })
  const c = buildDemoCatalog(MANIFEST, { stats: statDemoFiles(files) })
  await installDemoMedia({ catalog: c, files, cache })

  // The shim serves a cache hit with cache.readStream(id, start, end) and nothing else,
  // so a correct range read here IS demo playback working.
  const track = c.tracks.find((x) => x.path === 'a.mp3')
  const original = fs.readFileSync(files['a.mp3'])
  const chunks = []
  const rs = cache.readStream(track.id, 100, 199)
  for await (const chunk of rs) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), original.subarray(100, 200))
})

test('install is idempotent, and re-pins an entry an older install left unpinned', async (t) => {
  const { files } = await bundle(t, ['a.mp3', 'b.mp3', 'c.mp3', 'cover.jpg'])
  const cache = new AudioCache({ dir: await dir(t), cap: 0 })
  const artStore = new ArtStore({ dir: await dir(t) })
  const c = buildDemoCatalog(MANIFEST, { stats: statDemoFiles(files) })

  await installDemoMedia({ catalog: c, files, cover: files['cover.jpg'], cache, artStore })
  cache.setPinned(c.tracks[0].id, false)

  const again = await installDemoMedia({ catalog: c, files, cover: files['cover.jpg'], cache, artStore })
  assert.equal(again.installed, 0)
  assert.equal(again.skipped, 3)
  assert.equal(again.art, true)
  assert.ok(cache.isPinned(c.tracks[0].id), 'a second install must repair the pin')
})

test('a missing bundled file is skipped, not fatal', async (t) => {
  const { files } = await bundle(t, ['a.mp3', 'c.mp3'])
  const cache = new AudioCache({ dir: await dir(t), cap: 0 })
  const c = buildDemoCatalog(MANIFEST, { stats: statDemoFiles(files) })

  const r = await installDemoMedia({ catalog: c, files, cache })
  assert.equal(r.installed, 2)
  assert.equal(r.failed, 1) // b.mp3 was never bundled
  assert.equal(cache.count(), 2)
})

test('remove gives the bytes back and forgets the index rows for good', async (t) => {
  const { files } = await bundle(t, ['a.mp3', 'b.mp3', 'c.mp3', 'cover.jpg'])
  const cacheDir = await dir(t)
  const artDir = await dir(t)
  const cache = new AudioCache({ dir: cacheDir, cap: 0 })
  const artStore = new ArtStore({ dir: artDir })
  const c = buildDemoCatalog(MANIFEST, { stats: statDemoFiles(files) })
  await installDemoMedia({ catalog: c, files, cover: files['cover.jpg'], cache, artStore })

  const r = removeDemoMedia({ catalog: c, cache, artStore })
  assert.equal(r.removed, 3)
  assert.equal(cache.count(), 0)
  assert.equal(cache.totalBytes(), 0)
  assert.equal(artStore.has(c.album.coverId), false)
  for (const track of c.tracks) assert.equal(fs.existsSync(path.join(cacheDir, track.id)), false)

  // The index was SAVED, not just mutated in memory - a reopened cache must agree, or
  // the rows come back on the next launch pointing at files that are gone.
  assert.equal(new AudioCache({ dir: cacheDir, cap: 0 }).count(), 0)
})

test('remove leaves another library\'s cached audio alone', async (t) => {
  const { files } = await bundle(t, ['a.mp3', 'b.mp3', 'c.mp3'])
  const cache = new AudioCache({ dir: await dir(t), cap: 0 })
  const c = buildDemoCatalog(MANIFEST, { stats: statDemoFiles(files) })
  await installDemoMedia({ catalog: c, files, cache })

  const sink = cache.createSink('someoneelsestrack', { mime: 'audio/flac', size: 10, library: 'otherlib' })
  sink.write(Buffer.alloc(10))
  await sink.commit()

  removeDemoMedia({ catalog: c, cache })
  assert.equal(cache.count(), 1)
  assert.ok(cache.has('someoneelsestrack'))
})

test('the SHIPPED manifest builds the library the demo path promises', () => {
  const dir = path.join(__dirname, '..', 'assets', 'demo-music')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const c = buildDemoCatalog(manifest)

  assert.equal(c.tracks.length, 5, 'the proposal budgets three to five tracks')
  assert.equal(c.albums.length, 1)
  assert.equal(c.artists.length, 1)
  // Numbered 1-5 with no gap: a hole in the album view reads as a failed load, which
  // is the exact impression the demo exists to prevent (see assets/demo-music/LICENSE.md).
  assert.deepEqual(c.tracks.map((t) => t.track), [1, 2, 3, 4, 5])
  for (const t of c.tracks) {
    assert.ok(t.title, 'a track with no title')
    assert.ok(t.durationMs > 0, 'a track with no duration')
    assert.equal(t.coverId, c.album.coverId, 'art on every track')
  }

  // Every file the manifest names is actually in the bundle, and the cover too.
  for (const t of manifest.tracks) assert.ok(fs.existsSync(path.join(dir, t.file)), `missing ${t.file}`)
  assert.ok(fs.existsSync(path.join(dir, manifest.cover)), 'missing cover')

  // The licence is the reason this is shippable at all; losing the file would lose the
  // only record of why.
  assert.match(fs.readFileSync(path.join(dir, 'LICENSE.md'), 'utf8'), /CC0/)
})
