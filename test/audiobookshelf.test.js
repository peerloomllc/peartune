'use strict'

// The Audiobookshelf adapter (proposal 2026-09-13-audiobookshelf-books-source, slice 1),
// against a fake Audiobookshelf built from real 2.36.0 responses (test/fixtures/audiobookshelf,
// captured from the Umbrel): a single-file m4b with three chapters and a book in five mp3 parts.

const test = require('node:test')
const assert = require('node:assert/strict')
const hcrypto = require('hypercore-crypto')

const { AudiobookshelfAdapter, chaptersForTrack } = require('../host/adapters/audiobookshelf')
const { libraryId } = require('../protocol/ids')

const { fakeAbs, FILE_BYTES } = require('./fixtures/audiobookshelf/fake-server')
const LIB = libraryId(hcrypto.randomBytes(32))

async function drain (stream) {
  const chunks = []
  for await (const c of stream) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks)
}

test('chapters are cut to each file and dropped when they only repeat the files', () => {
  const book = [{ start: 0, title: 'One' }, { start: 100, title: 'Two' }, { start: 250, title: 'Three' }, { start: 400, title: 'Four' }]
  // A file from 200 s to 500 s holds chapters Three and Four, on its own clock.
  assert.deepEqual(chaptersForTrack(book, 200, 300), [{ title: 'Three', startMs: 50000 }, { title: 'Four', startMs: 200000 }])
  // One chapter per file (a book in parts) is no chapter list.
  const perFile = [{ start: 0, title: 'Part 1' }, { start: 180, title: 'Part 2' }]
  assert.deepEqual(chaptersForTrack(perFile, 180, 180), [])
})

test('a scan serves every book library, skips podcasts, and maps books, files and chapters', async (t) => {
  const abs = await fakeAbs(t)
  const a = new AudiobookshelfAdapter({ url: abs.url, apiKey: 'key-1', libraryId: LIB })
  assert.equal(await a.scan(), 6, '1 file + 5 parts')
  assert.equal(abs.seen.some(r => r.path.includes('pod-lib-1')), false)

  const albums = (await a.list({ type: 'albums', kind: 'book' })).items
  assert.deepEqual(albums.map(x => [x.name, x.artist, x.songCount, x.kind]).sort(), [
    ['The Book in Parts', 'PearTune Test Author', 5, 'book'],
    ['The Short Book', 'PearTune Test Author', 1, 'book']
  ])

  const short = await a.get({ type: 'album', id: albums.find(x => x.name === 'The Short Book').id })
  const t0 = short.tracks[0]
  assert.equal(t0.kind, 'book')
  assert.equal(t0.suffix, 'm4b')
  assert.equal(t0.durationMs, 540000 + 46)
  assert.equal(t0.size, 4425562)
  assert.deepEqual(t0.chapters.map(c => [c.title, c.startMs]), [['Chapter 1', 0], ['Chapter 2', 180000], ['Chapter 3', 360000]])
  assert.equal('_abs' in t0, false, 'internal routing fields never reach the phone')

  const parts = await a.get({ type: 'album', id: albums.find(x => x.name === 'The Book in Parts').id })
  assert.deepEqual(parts.tracks.map(x => x.title), ['Part 1', 'Part 2', 'Part 3', 'Part 4', 'Part 5'])
  assert.equal(parts.tracks.some(x => 'chapters' in x), false)

  const st = await a.stats()
  assert.equal(st.books, 2)
  assert.equal(st.sourceName, 'Audiobookshelf')
})

test('everything is a book: kind music is empty, search finds books, ids are stable', async (t) => {
  const abs = await fakeAbs(t)
  const a = new AudiobookshelfAdapter({ url: abs.url, apiKey: 'key-1', libraryId: LIB })
  await a.scan()
  assert.equal((await a.list({ type: 'albums', kind: 'music' })).items.length, 0)
  assert.equal((await a.list({ type: 'artists', kind: 'music' })).items.length, 0)
  assert.equal((await a.list({ type: 'artists' })).items[0].kind, 'book')
  const hits = await a.search({ q: 'parts' })
  assert.equal(hits.albums[0].name, 'The Book in Parts')
  assert.equal(hits.tracks.length, 5)
  assert.equal((await a.search({ q: 'parts', kind: 'music' })).albums.length, 0)

  const again = new AudiobookshelfAdapter({ url: abs.url, apiKey: 'key-1', libraryId: LIB })
  await again.scan()
  const ids = async (x) => (await x.list({ type: 'tracks', limit: 100 })).items.map(i => i.id).sort()
  assert.deepEqual(await ids(again), await ids(a), 'a rescan must not orphan resume positions or bookmarks')
})

test('art and audio: a cover by its album id, and byte ranges passed straight through', async (t) => {
  const abs = await fakeAbs(t)
  const a = new AudiobookshelfAdapter({ url: abs.url, apiKey: 'key-1', libraryId: LIB })
  await a.scan()
  const album = (await a.list({ type: 'albums' })).items.find(x => x.name === 'The Short Book')
  assert.equal((await drain(await a.art({ coverId: album.coverId, size: 300 }))).toString(), 'RIFFcover')
  assert.equal(abs.seen.find(r => r.path.endsWith('/cover')).query, '?width=300')
  assert.equal(await a.art({ coverId: 'nope' }), null)

  const track = (await a.get({ type: 'album', id: album.id })).tracks[0]
  const part = await drain(await a.stream({ trackId: track.id, offset: 100, length: 10 }))
  assert.deepEqual([...part], [...FILE_BYTES.subarray(100, 110)])
  const req = abs.seen.find(r => r.path.includes('/file/'))
  assert.equal(req.range, 'bytes=100-109')
  assert.equal(req.auth, 'Bearer key-1')
  assert.equal(await a.stream({ trackId: 'nope' }), null)
})

test('username and password: logs in, and logs in again once when the token expires', async (t) => {
  const abs = await fakeAbs(t)
  const a = new AudiobookshelfAdapter({ url: abs.url, username: 'root', password: 'pw', libraryId: LIB })
  await a.scan()
  assert.equal(abs.logins(), 1)
  abs.revoke('fresh-1')
  assert.equal((await a.probe()).books, 2)
  assert.equal(abs.logins(), 2)

  const wrong = new AudiobookshelfAdapter({ url: abs.url, username: 'root', password: 'nope', libraryId: LIB })
  await assert.rejects(wrong.scan(), /wrong username or password/)
  const badKey = new AudiobookshelfAdapter({ url: abs.url, apiKey: 'wrong', libraryId: LIB })
  await assert.rejects(badKey.probe(), /API key or login was refused/)
  await assert.rejects(new AudiobookshelfAdapter({ url: abs.url, libraryId: LIB }).probe(), /API key or a username/)
})
