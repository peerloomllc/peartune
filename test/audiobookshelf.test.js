'use strict'

// The Audiobookshelf adapter (proposal 2026-09-13-audiobookshelf-books-source, slice 1),
// against a fake Audiobookshelf built from real 2.36.0 responses (test/fixtures/audiobookshelf,
// captured from the Umbrel): a single-file m4b with three chapters and a book in five mp3 parts.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const path = require('path')
const fs = require('fs')
const hcrypto = require('hypercore-crypto')

const { AudiobookshelfAdapter, chaptersForTrack } = require('../host/adapters/audiobookshelf')
const { libraryId } = require('../protocol/ids')

const FIX = path.join(__dirname, 'fixtures', 'audiobookshelf')
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'))
const LIB = libraryId(hcrypto.randomBytes(32))
const SHORT = '8dc29fa1-016d-4141-ad9f-6576a2fcaee5'
const PARTS = '31d47626-3c69-4de0-9324-8e1c777f86f4'
const FILE_BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))

// A fake server. `tokens` are what it accepts; `/login` mints `fresh-N`. Every request is
// recorded so tests can see what was asked for.
async function fakeAbs (t, { apiKey = 'key-1', password = 'pw' } = {}) {
  const libraries = read('libraries.json')
  const page0 = read('items-page0.json')
  const items = { [SHORT]: read('item-8dc29fa1.json'), [PARTS]: read('item-31d47626.json') }
  const tokens = new Set([apiKey])
  const seen = []
  let logins = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    seen.push({ path: url.pathname, query: url.search, auth: req.headers.authorization || null, range: req.headers.range || null })
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const { password: pw } = JSON.parse(body || '{}')
        if (pw !== password) return json(401, {})
        const tok = `fresh-${++logins}`
        tokens.add(tok)
        json(200, { user: { accessToken: tok, refreshToken: 'r' }, serverSettings: { version: '2.36.0' } })
      })
      return
    }
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '')
    if (!tokens.has(bearer)) return json(401, {})
    if (url.pathname === '/api/libraries') return json(200, libraries)
    if (url.pathname === '/api/libraries/pod-lib-1/items') throw new Error('podcast library was listed')
    if (/^\/api\/libraries\/[^/]+\/items$/.test(url.pathname)) return json(200, page0)
    let m = url.pathname.match(/^\/api\/items\/([^/]+)$/)
    if (m) return items[m[1]] ? json(200, items[m[1]]) : json(404, {})
    m = url.pathname.match(/^\/api\/items\/([^/]+)\/cover$/)
    if (m) { res.writeHead(200, { 'content-type': 'image/webp' }); return res.end(Buffer.from('RIFFcover')) }
    m = url.pathname.match(/^\/api\/items\/([^/]+)\/file\/([^/]+)$/)
    if (m) {
      const r = (req.headers.range || '').match(/bytes=(\d+)-(\d*)/)
      if (!r) { res.writeHead(200, { 'content-type': 'audio/mp4' }); return res.end(FILE_BYTES) }
      const start = Number(r[1]); const end = r[2] ? Number(r[2]) : FILE_BYTES.length - 1
      res.writeHead(206, { 'content-type': 'audio/mp4', 'content-range': `bytes ${start}-${end}/${FILE_BYTES.length}` })
      return res.end(FILE_BYTES.subarray(start, end + 1))
    }
    json(404, {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    revoke: (tok) => tokens.delete(tok),
    logins: () => logins
  }
}

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
