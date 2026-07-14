// The folder adapter, with its tag reader.
//
// This is the source a stranger who installs PearTune from an app store actually
// gets, so these tests are about FIRST IMPRESSIONS: does a plain directory of files
// come back as a music library, or as a list of filenames?
//
// The fixtures (test/fixtures/music, made by scripts/make-music-fixtures.sh) are one
// second of silence each and are chosen entirely for their TAGS. Every directory in
// there is a case that has broken a real music scanner.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')

const { FolderAdapter } = require('../host/adapters/folder')
const { libraryId, trackId } = require('../protocol/ids')
const hcrypto = require('hypercore-crypto')

const MUSIC = path.join(__dirname, 'fixtures', 'music')
const LIB = libraryId(hcrypto.randomBytes(32))

async function scanned (root = MUSIC) {
  const a = new FolderAdapter({ root, libraryId: LIB })
  await a.scan()
  return a
}

const byName = (items, name) => items.find(x => x.name === name)

async function drain (stream) {
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return Buffer.concat(chunks)
}

test('a folder of files becomes a LIBRARY: artists, albums, tracks', async () => {
  const a = await scanned()
  const stats = await a.stats()

  assert.equal(stats.tracks, 8)
  assert.equal(stats.albums, 5)
  assert.equal(stats.artists, 5)

  // The old adapter answered 0 albums and 0 artists, always. That is the whole
  // reason this file exists.
  assert.ok(stats.albums > 0 && stats.artists > 0)
})

test('tags are read, not guessed from the filename', async () => {
  const a = await scanned()
  const { items } = await a.list({ type: 'tracks' })
  const dog = items.find(t => t.title === 'Black Dog')

  assert.ok(dog, 'the ID3 title, not "01 Black Dog"')
  assert.equal(dog.artist, 'Led Zeppelin')
  assert.equal(dog.album, 'Led Zeppelin IV')
  assert.equal(dog.track, 1)
  assert.equal(dog.disc, 1)
  assert.equal(dog.year, 1971)
  assert.equal(dog.suffix, 'mp3')
  assert.ok(dog.durationMs > 0, 'a duration the app can show')
  assert.ok(dog.coverId, 'something to hang artwork on')
})

test('Vorbis (FLAC) and MP4 (m4a) tags too, not just ID3', async () => {
  const a = await scanned()
  const { items } = await a.list({ type: 'tracks' })

  const flac = items.find(t => t.title === 'Hey You')
  assert.equal(flac.artist, 'Pink Floyd')
  assert.equal(flac.suffix, 'flac')

  const m4a = items.find(t => t.title === 'Song A')
  assert.equal(m4a.artist, 'Artist A')
  assert.equal(m4a.suffix, 'm4a')
})

// The three inferences that decide whether a folder library looks sane. Each of
// these is a way real libraries break other scanners.

test('ONE album split across CD1/ and CD2/ stays one album', async () => {
  const a = await scanned()
  const { items } = await a.list({ type: 'albums' })

  const wall = byName(items, 'The Wall')
  assert.ok(wall, 'The Wall is one album, not two')
  assert.equal(items.filter(x => x.name === 'The Wall').length, 1)
  assert.equal(wall.songCount, 2)

  const full = await a.get({ id: wall.id, type: 'album' })
  assert.deepEqual(full.tracks.map(t => t.disc), [1, 2], 'in disc order')
})

test('a compilation does NOT splinter into one album per artist', async () => {
  const a = await scanned()
  const { items } = await a.list({ type: 'albums' })

  // Two tracks, two different track artists, one album tag, NO albumartist tag.
  // Grouping by (track artist, album) - the obvious implementation - gives two
  // albums called "Test Hits" with one song each, which is how compilations get
  // mangled.
  const hits = items.filter(x => x.name === 'Test Hits')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].songCount, 2)
  assert.equal(hits[0].artist, 'Various Artists', 'the tags never said, and the performers differ')
})

test('an untagged file still shows up, under its directory', async () => {
  const a = await scanned()
  const { items } = await a.list({ type: 'albums' })

  const untagged = byName(items, 'Untagged')
  assert.ok(untagged, 'the directory is the album when nothing else is')
  assert.equal(untagged.artist, 'Unknown Artist')

  const full = await a.get({ id: untagged.id, type: 'album' })
  assert.equal(full.tracks[0].title, 'mystery recording', 'the filename is the title of last resort')
})

test('an artist page is that artist\'s albums', async () => {
  const a = await scanned()
  const { items } = await a.list({ type: 'artists' })

  const zep = byName(items, 'Led Zeppelin')
  assert.equal(zep.albumCount, 1)
  assert.ok(zep.coverId, 'an artist tile has a picture: their first album')

  const full = await a.get({ id: zep.id, type: 'artist' })
  assert.equal(full.albums.length, 1)
  assert.equal(full.albums[0].name, 'Led Zeppelin IV')
})

test('search finds artists, albums and tracks - and still searches the PATH', async () => {
  const a = await scanned()

  const hey = await a.search({ q: 'hey' })
  assert.equal(hey.tracks[0].title, 'Hey You')

  const floyd = await a.search({ q: 'floyd' })
  assert.equal(floyd.artists[0].name, 'Pink Floyd')
  assert.ok(floyd.albums.some(x => x.name === 'The Wall'), 'an album by a matching artist')

  // The path stays searchable. It is the only thing an untagged library has, and
  // dropping it the day we learned to read tags would make search WORSE for the
  // people this adapter exists for.
  const byPath = await a.search({ q: 'mystery' })
  assert.equal(byPath.tracks.length, 1)

  assert.deepEqual(await a.search({ q: '' }), { artists: [], albums: [], tracks: [] })
})

test('artwork: embedded art, and a cover.jpg beside the music', async () => {
  const a = await scanned()
  const { items } = await a.list({ type: 'albums' })

  const zep = byName(items, 'Led Zeppelin IV')
  const embedded = await drain(await a.art({ coverId: zep.coverId }))
  assert.ok(embedded.length > 0)
  assert.equal(embedded.subarray(0, 3).toString('hex'), 'ffd8ff', 'a JPEG, pulled out of the ID3 tag')

  // An image FILE next to the music wins over an embedded one: it is usually the
  // better scan, and reading it costs one open() instead of parsing a whole FLAC.
  const messiah = byName(items, 'Messiah')
  const external = await drain(await a.art({ coverId: messiah.coverId }))
  const onDisk = await fsp.readFile(path.join(MUSIC, 'Handel', 'Messiah', 'cover.jpg'))
  assert.deepEqual(external, onDisk, 'byte for byte the cover.jpg on disk')

  // No art anywhere is a normal answer, not an error.
  const untagged = byName(items, 'Untagged')
  assert.equal(await a.art({ coverId: untagged.coverId }), null)
  assert.equal(await a.art({ coverId: 'nonsense' }), null)
  assert.equal(await a.art({}), null)
})

test('the art cache remembers a MISS, not just a hit', async () => {
  const a = await scanned()
  const { items } = await a.list({ type: 'albums' })
  const untagged = byName(items, 'Untagged')

  await a.art({ coverId: untagged.coverId })
  // Without a negative cache, an album with no art re-parses its files every time
  // its tile scrolls past. Forever.
  assert.ok(a.artCache.has(untagged.coverId))
  assert.equal(a.artCache.get(untagged.coverId), null)
})

test('a track id is the PATH, so a rescan does not orphan play counts', async () => {
  const a = await scanned()
  const { items } = await a.list({ type: 'tracks' })
  const dog = items.find(t => t.title === 'Black Dog')

  // Derived from the library-relative path, and from nothing else. If it were
  // derived from the tags, fixing a typo in a title would orphan that track's
  // resume position and play count (DECISIONS 2026-07-13).
  assert.equal(dog.id, trackId(LIB, 'folder', path.join('Led Zeppelin', 'IV', '01 Black Dog.mp3')))

  const again = await scanned()
  const same = (await again.list({ type: 'tracks' })).items.find(t => t.title === 'Black Dog')
  assert.equal(same.id, dog.id, 'stable across a rescan')
})

test('the phone never learns the host\'s filesystem layout', async () => {
  const a = await scanned()
  const { items } = await a.list({ type: 'tracks' })
  for (const t of items) assert.equal(t.absPath, undefined)

  const one = await a.get({ id: items[0].id })
  assert.equal(one.absPath, undefined)
  assert.ok(one.path, 'the library-RELATIVE path is fine, and useful')
})

test('non-audio files are not tracks', async () => {
  const a = await scanned()
  const { items } = await a.list({ type: 'tracks' })
  assert.ok(!items.some(t => t.title.includes('notes')), 'notes.txt sits in the fixture library')
})

test('streaming: whole file, and a range for seeking', async () => {
  const a = await scanned()
  const { items } = await a.list({ type: 'tracks' })
  const t = items[0]

  const whole = await drain(await a.stream({ trackId: t.id }))
  assert.equal(whole.length, t.size)

  const part = await drain(await a.stream({ trackId: t.id, offset: 10, length: 32 }))
  assert.equal(part.length, 32)
  assert.deepEqual(part, whole.subarray(10, 42))

  assert.equal(await a.stream({ trackId: 'nope' }), null)
  assert.equal(await a.stream({ trackId: t.id, offset: t.size }), null, 'past the end')
})

// THE BUG THAT COST A REAL EVENING.
//
// Tim typed the path Navidrome uses on the HOST (/home/umbrel/.../music) into the
// dashboard and got zero tracks. Correctly - that path does not exist inside the
// container - but "0 tracks" is indistinguishable from an empty library, so it looks
// like PearTune is broken rather than like the path is wrong.
test('a folder that does not exist THROWS, and says what the container can see', async () => {
  const a = new FolderAdapter({ root: '/definitely/not/mounted', libraryId: LIB })
  await assert.rejects(a.scan(), (e) => {
    assert.match(e.message, /does not exist inside the PearTune container/)
    assert.match(e.message, /MOUNTED/)
    return true
  })
})

test('a FILE where a folder should be is also an error, not an empty library', async (t) => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-folder-'))
  t.after(() => fsp.rm(d, { recursive: true, force: true }))
  const f = path.join(d, 'music.mp3')
  await fsp.writeFile(f, 'not a folder')

  const a = new FolderAdapter({ root: f, libraryId: LIB })
  await assert.rejects(a.scan(), /is a file, not a folder/)
})

test('an EMPTY folder is not an error - it is an empty folder', async (t) => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-folder-'))
  t.after(() => fsp.rm(d, { recursive: true, force: true }))

  const a = new FolderAdapter({ root: d, libraryId: LIB })
  assert.equal(await a.scan(), 0)
  assert.deepEqual((await a.list({ type: 'albums' })).items, [])
})

test('a file with unreadable tags is still a track', async (t) => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-folder-'))
  t.after(() => fsp.rm(d, { recursive: true, force: true }))
  // Random bytes with an audio extension: this is exactly what test/integration
  // writes, and what a truncated download looks like.
  await fsp.writeFile(path.join(d, 'broken.flac'), Buffer.alloc(64, 7))

  const a = new FolderAdapter({ root: d, libraryId: LIB })
  assert.equal(await a.scan(), 1, 'the file exists and plays; losing it would be the tag reader making things worse')

  const { items } = await a.list({ type: 'tracks' })
  assert.equal(items[0].title, 'broken')
})

test('two scans of the same library are identical (ids and all)', async () => {
  const a = await scanned()
  const b = await scanned()
  assert.deepEqual(
    (await a.list({ type: 'albums' })).items,
    (await b.list({ type: 'albums' })).items
  )
})

test('a rescan while one is running is the SAME scan, not a second one', async () => {
  const a = new FolderAdapter({ root: MUSIC, libraryId: LIB })
  const [x, y] = await Promise.all([a.scan(), a.scan()])
  assert.equal(x, y)
  assert.equal((await a.stats()).tracks, 8, 'not doubled')
})
