// Audiobooks in a folder library (proposal 2026-09-13, slice 1).
//
// A track is a book when its file is .m4b, or when it sits under a folder root the
// owner marked as Audiobooks. An album is a book when every track in it is. Music keeps
// NO `kind` at all, so an older phone sees exactly what it saw before.
//
// Fixtures: test/fixtures/books, made by scripts/make-book-fixtures.sh.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')

const { FolderAdapter, AUDIO_EXT } = require('../host/adapters/folder')
const { SourceStore, migrate } = require('../host/source')
const { mimeFor } = require('../worklet/shim')
const { libraryId } = require('../protocol/ids')
const hcrypto = require('hypercore-crypto')

const BOOKS = path.join(__dirname, 'fixtures', 'books')
const MUSIC = path.join(__dirname, 'fixtures', 'music')
const LIB = libraryId(hcrypto.randomBytes(32))

async function scanned (opts) {
  const a = new FolderAdapter({ libraryId: LIB, ...opts })
  await a.scan()
  return a
}

async function allTracks (a) {
  return (await a.list({ type: 'tracks', limit: 1000 })).items
}

async function allAlbums (a) {
  return (await a.list({ type: 'albums', limit: 1000 })).items
}

async function drain (stream) {
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return Buffer.concat(chunks)
}

test('an .m4b is scanned, and is a book by its extension alone', async () => {
  assert.ok(AUDIO_EXT.has('.m4b'))
  const a = await scanned({ roots: [BOOKS] })
  const t = (await allTracks(a)).find(x => x.suffix === 'm4b')
  assert.ok(t, 'the m4b was not scanned')
  assert.equal(t.title, 'Short Book')
  assert.equal(t.artist, 'Test Author')
  assert.equal(t.kind, 'book')
  assert.ok(t.durationMs >= 1900 && t.durationMs <= 2200, `duration ${t.durationMs}`)

  const album = (await allAlbums(a)).find(x => x.name === 'Short Book')
  assert.equal(album.kind, 'book')
  const detail = await a.get({ id: album.id, type: 'album' })
  assert.equal(detail.kind, 'book')
  assert.equal(detail.tracks[0].kind, 'book')
})

test("an m4b's embedded cover is its album art", async () => {
  const a = await scanned({ roots: [BOOKS] })
  const album = (await allAlbums(a)).find(x => x.name === 'Short Book')
  const art = await a.art({ coverId: album.coverId })
  assert.ok(art, 'no cover')
  const buf = await drain(art)
  assert.equal(buf[0], 0xff) // a JPEG
  assert.equal(buf[1], 0xd8)
})

test('an unmarked folder of mp3 parts is MUSIC: no kind on tracks or album', async () => {
  const a = await scanned({ roots: [BOOKS] })
  const parts = (await allTracks(a)).filter(x => x.album === 'Book in Parts')
  assert.equal(parts.length, 2)
  for (const t of parts) assert.equal('kind' in t, false)
  const album = (await allAlbums(a)).find(x => x.name === 'Book in Parts')
  assert.equal('kind' in album, false)
})

test('a root marked as Audiobooks makes everything under it a book, and nothing else', async () => {
  const a = await scanned({ roots: [MUSIC, BOOKS], bookRoots: [BOOKS] })
  const tracks = await allTracks(a)
  const parts = tracks.filter(x => x.album === 'Book in Parts')
  assert.equal(parts.length, 2)
  for (const t of parts) assert.equal(t.kind, 'book')

  const music = tracks.filter(x => x.album !== 'Book in Parts' && x.suffix !== 'm4b')
  assert.ok(music.length > 0)
  for (const t of music) assert.equal('kind' in t, false, `${t.title} became a book`)

  const albums = await allAlbums(a)
  assert.equal(albums.find(x => x.name === 'Book in Parts').kind, 'book')
  assert.equal('kind' in albums.find(x => x.name === 'Led Zeppelin IV'), false)

  const hits = await a.search({ q: 'Book in Parts' })
  assert.equal(hits.albums.find(x => x.name === 'Book in Parts').kind, 'book')
})

test('a mark on anything but a top-level root is ignored', async () => {
  const a = await scanned({ roots: [BOOKS], bookRoots: [path.join(BOOKS, 'Book in Parts'), '/nowhere'] })
  assert.equal(a.bookRoots.size, 0)
  const parts = (await allTracks(a)).filter(x => x.album === 'Book in Parts')
  for (const t of parts) assert.equal('kind' in t, false)
})

test('an album is a book only when EVERY track in it is', () => {
  // One album (same album and albumartist tags) holding an m4b and an mp3, in an
  // unmarked root: the m4b is a book, the mp3 is not, so the album is music.
  const a = new FolderAdapter({ roots: ['/lib'], libraryId: LIB })
  const row = (relPath, suffix) => ({
    relPath, sourceKey: relPath, root: '/lib', absPath: '/lib/' + relPath, size: 1, addedAt: 1, suffix,
    title: relPath, artist: 'Author', albumArtist: 'Author', album: 'Mixed', track: null, disc: null, year: null, genre: null, durationMs: 1000
  })
  a._build([row('Mixed/a.m4b', 'm4b'), row('Mixed/b.mp3', 'mp3')])
  const tracks = [...a.tracks.values()]
  assert.equal(tracks.find(x => x.suffix === 'm4b').kind, 'book')
  assert.equal('kind' in tracks.find(x => x.suffix === 'mp3'), false)
  assert.equal(a.albums.size, 1)
  assert.equal('kind' in [...a.albums.values()][0], false)
})

test('a narrowed person still sees which albums are books', async () => {
  const a = await scanned({ roots: [MUSIC, BOOKS], bookRoots: [BOOKS] })
  assert.equal(a.books, true)
  const view = a.narrowedView([{ root: BOOKS, rel: '' }])
  assert.equal(view.books, true)
  const albums = await allAlbums(view)
  assert.ok(albums.length > 0)
  for (const al of albums) assert.equal(al.kind, 'book')
})

test('list and search take kind: books and music come back apart, and pages stay full', async () => {
  const a = await scanned({ roots: [MUSIC, BOOKS], bookRoots: [BOOKS] })
  const names = (items) => items.map(x => x.name).sort()

  const all = await allAlbums(a)
  const books = (await a.list({ type: 'albums', limit: 1000, kind: 'book' })).items
  const music = (await a.list({ type: 'albums', limit: 1000, kind: 'music' })).items
  assert.deepEqual(names(books), ['Book in Parts', 'Short Book'])
  assert.equal(books.length + music.length, all.length)
  for (const x of music) assert.equal('kind' in x, false)

  // A page of music is a FULL page: filtered before paging, so cursors count what is shown.
  const first = await a.list({ type: 'albums', limit: 2, kind: 'music' })
  assert.equal(first.items.length, 2)
  assert.equal(first.nextCursor, 2)

  // An author with only books, and a genre with only books, leave the music views.
  const artists = (await a.list({ type: 'artists', kind: 'music' })).items
  assert.equal(artists.some(x => x.name === 'Test Author'), false)
  assert.equal((await a.list({ type: 'artists', kind: 'book' })).items.find(x => x.name === 'Test Author').kind, 'book')
  const genres = (await a.list({ type: 'genres', kind: 'music' })).items
  assert.equal(genres.some(x => x.name === 'Audiobook'), false)

  const tracks = (await a.list({ type: 'tracks', limit: 1000, kind: 'music' })).items
  assert.equal(tracks.some(t => t.kind === 'book'), false)

  // No kind (an older phone) still gets everything.
  assert.equal((await a.list({ type: 'artists' })).items.some(x => x.name === 'Test Author'), true)

  const hit = await a.search({ q: 'book', kind: 'music' })
  assert.equal(hit.albums.length + hit.tracks.length + hit.artists.length, 0)
  const bookHit = await a.search({ q: 'book', kind: 'book' })
  assert.deepEqual(names(bookHit.albums), ['Book in Parts', 'Short Book'])

  assert.equal((await a.stats()).books, 2)
})

test('the phone labels an m4b as audio/mp4, not octet-stream', () => {
  assert.equal(mimeFor('Short Book.m4b'), 'audio/mp4')
  assert.equal(mimeFor('x.M4B'), 'audio/mp4')
})

test('a whole book over 64 MB is not cached on the way past; music and small parts are', () => {
  const { cacheWholeTrack, BOOK_CACHE_MAX_BYTES } = require('../worklet/shim')
  const big = BOOK_CACHE_MAX_BYTES + 1
  assert.equal(cacheWholeTrack({ full: true, kind: 'book', size: big }), false)
  assert.equal(cacheWholeTrack({ full: true, kind: 'book', size: 5 * 1024 * 1024 }), true)
  assert.equal(cacheWholeTrack({ full: true, kind: null, size: big }), true)
  assert.equal(cacheWholeTrack({ full: false, kind: null, size: 10 }), false)
})

test('merged libraries: a book stays a book only when every copy is one, and serveList/search filter by kind', () => {
  const merge = require('../worklet/merge')
  const catalog = require('../worklet/catalog')
  const album = (lib, name, kind) => ({ id: lib + name, name, artist: 'A', year: 2026, songCount: 1, coverId: 'c', ...(kind ? { kind } : {}) })
  const ix = merge.buildIndex([
    { libraryId: 'L1', albums: [album('L1', 'Only Book', 'book'), album('L1', 'Clash', 'book'), album('L1', 'Song Album')] },
    { libraryId: 'L2', albums: [album('L2', 'Only Book', 'book'), album('L2', 'Clash')] }
  ])
  const byName = (n) => ix.albums.find(a => a.name === n)
  assert.equal(byName('Only Book').kind, 'book')
  assert.equal('kind' in byName('Clash'), false, 'a book deduped with a music album stays music')
  assert.equal('kind' in byName('Song Album'), false)

  const names = (items) => items.map(a => a.name).sort()
  assert.deepEqual(names(catalog.serveList(ix.albums, { kind: 'book' }).items), ['Only Book'])
  assert.deepEqual(names(catalog.serveList(ix.albums, { kind: 'music' }).items), ['Clash', 'Song Album'])
  assert.equal(catalog.serveList(ix.albums, {}).items.length, 3)
  assert.deepEqual(names(catalog.searchIndex(ix, 'o', { kind: 'music' }).albums), ['Song Album'])
})

// --- the saved config -------------------------------------------------------

async function dir (t) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-src-'))
  t.after(() => fsp.rm(d, { recursive: true, force: true }))
  return d
}

test('bookRoots is saved, and only for roots the source actually has', async (t) => {
  const d = await dir(t)
  const s = new SourceStore({ dataDir: d, musicDir: '/music' })
  s.save({ kind: 'folder', roots: ['/library/music', '/library/audiobooks'], bookRoots: ['/library/audiobooks', '/library/audiobooks/sub', '/elsewhere'] })

  const again = new SourceStore({ dataDir: d, musicDir: '/music' })
  assert.deepEqual(again.active().bookRoots, ['/library/audiobooks'])
  assert.deepEqual(again.view().kinds.folder.bookRoots, ['/library/audiobooks'])

  // Removing the folder drops its mark with it.
  again.save({ kind: 'folder', roots: ['/library/music'], bookRoots: ['/library/audiobooks'] })
  assert.equal(again.active().bookRoots, undefined)
  assert.deepEqual(again.view().kinds.folder.bookRoots, [])
})

test('a config saved before books existed loads unchanged', async (t) => {
  const d = await dir(t)
  fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify({ version: 2, active: 'folder', sources: { folder: { roots: ['/library/music'] } } }))
  const s = new SourceStore({ dataDir: d, musicDir: '/music' })
  assert.deepEqual(s.active().roots, ['/library/music'])
  assert.equal(s.active().bookRoots, undefined)
  assert.deepEqual(s.view().kinds.folder.bookRoots, [])
  assert.deepEqual(migrate({ kind: 'folder', root: '/music' }).sources.folder, { roots: ['/music'] })
})
