'use strict'

// One library from two sources: a music folder plus an Audiobookshelf books source
// (host/adapters/combined.js, proposal 2026-09-13-audiobookshelf-books-source slice 2).

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const hcrypto = require('hypercore-crypto')

const { FolderAdapter } = require('../host/adapters/folder')
const { AudiobookshelfAdapter } = require('../host/adapters/audiobookshelf')
const { CombinedAdapter } = require('../host/adapters/combined')
const { SubsonicAdapter } = require('../host/adapters/subsonic')
const { viewOf } = require('../host/visibility')
const { libraryId } = require('../protocol/ids')
const { fakeAbs, FILE_BYTES } = require('./fixtures/audiobookshelf/fake-server')

const MUSIC = path.join(__dirname, 'fixtures', 'music')
const BOOKS = path.join(__dirname, 'fixtures', 'books')
const LIB = libraryId(hcrypto.randomBytes(32))
const names = (items) => items.map(x => x.name).sort()

async function drain (s) { const c = []; for await (const x of s) c.push(Buffer.from(x)); return Buffer.concat(c) }

async function combined (t, { roots = [MUSIC, BOOKS], bookRoots = [BOOKS], url } = {}) {
  const abs = url ? null : await fakeAbs(t)
  const music = new FolderAdapter({ roots, bookRoots, libraryId: LIB })
  const books = new AudiobookshelfAdapter({ url: url || abs.url, apiKey: 'key-1', libraryId: LIB })
  const c = new CombinedAdapter({ music, books })
  await c.scan()
  return { c, music, books, abs }
}

test('music views are the music source alone; Books merges folder books with Audiobookshelf', async (t) => {
  const { c, music } = await combined(t)
  assert.equal(c.kind, 'folder', 'the library keeps its music source identity')

  const musicAlbums = await c.list({ type: 'albums', limit: 1000, kind: 'music' })
  assert.deepEqual(musicAlbums, await music.list({ type: 'albums', limit: 1000, kind: 'music' }))

  const books = (await c.list({ type: 'albums', limit: 1000, kind: 'book' })).items
  assert.deepEqual(names(books), ['Book in Parts', 'Short Book', 'The Book in Parts', 'The Short Book'])
  const page = await c.list({ type: 'albums', limit: 3, kind: 'book' })
  assert.equal(page.items.length, 3)
  assert.equal(page.nextCursor, 3)

  const authors = (await c.list({ type: 'artists', kind: 'book' })).items.map(a => a.name)
  assert.ok(authors.includes('PearTune Test Author') && authors.includes('Test Author'))
  assert.equal((await c.list({ type: 'artists', kind: 'music' })).items.some(a => a.kind === 'book'), false)

  const st = await c.stats()
  assert.equal(st.books, 4)
  assert.equal(st.booksSource.books, 2)
  assert.equal(st.booksSource.error, null)
})

test('get, art and stream go to the source that owns the id', async (t) => {
  const { c } = await combined(t)
  const absBook = (await c.list({ type: 'albums', limit: 100, kind: 'book' })).items.find(x => x.name === 'The Short Book')
  const detail = await c.get({ type: 'album', id: absBook.id })
  assert.equal(detail.tracks[0].chapters.length, 3)
  const bytes = await drain(await c.stream({ trackId: detail.tracks[0].id, offset: 10, length: 5 }))
  assert.deepEqual([...bytes], [...FILE_BYTES.subarray(10, 15)])
  assert.equal((await drain(await c.art({ coverId: absBook.coverId }))).toString(), 'RIFFcover')

  const zep = (await c.list({ type: 'albums', limit: 100, kind: 'music' })).items.find(x => x.name === 'Led Zeppelin IV')
  assert.equal((await c.get({ type: 'album', id: zep.id })).tracks.length, 2)
})

test('a phone from before Books pages through the music, then the books', async (t) => {
  const { c } = await combined(t)
  const seen = []
  let cursor = 0
  for (let i = 0; i < 20 && cursor != null; i++) {
    const page = await c.list({ type: 'albums', limit: 4, cursor })
    seen.push(...page.items)
    cursor = page.nextCursor
  }
  const all = names(seen)
  assert.ok(all.includes('Led Zeppelin IV') && all.includes('The Short Book') && all.includes('The Book in Parts'))
  assert.equal(new Set(seen.map(x => x.id)).size, seen.length, 'no album twice')
})

test('search: music only, books only, or both', async (t) => {
  const { c } = await combined(t)
  assert.equal((await c.search({ q: 'book', kind: 'music' })).albums.length, 0)
  assert.deepEqual(names((await c.search({ q: 'book', kind: 'book' })).albums), ['Book in Parts', 'Short Book', 'The Book in Parts', 'The Short Book'])
  assert.ok((await c.search({ q: 'zeppelin' })).albums.length > 0)
})

test('an Audiobookshelf that is down does not take the music with it', async (t) => {
  const { c } = await combined(t, { url: 'http://127.0.0.1:9' })
  assert.ok((await c.list({ type: 'albums', limit: 100, kind: 'music' })).items.length > 0)
  const st = await c.stats()
  assert.match(st.booksSource.error, /fetch failed|ECONNREFUSED|refused/i)
  assert.equal(st.booksSource.books, 0)
})

test('a narrowed person hears only their music folders, and every Audiobookshelf book', async (t) => {
  const { c } = await combined(t, { roots: [MUSIC, BOOKS], bookRoots: [] })
  const grant = { paths: [{ root: path.resolve(MUSIC), rel: 'Handel' }] }
  const view = viewOf(c, grant)
  assert.notEqual(view, c)
  assert.deepEqual(names((await view.list({ type: 'albums', limit: 100, kind: 'music' })).items), ['Messiah'])
  assert.deepEqual(names((await view.list({ type: 'albums', limit: 100, kind: 'book' })).items), ['The Book in Parts', 'The Short Book'])
  const hidden = (await c.list({ type: 'albums', limit: 100, kind: 'music' })).items.find(x => x.name === 'Led Zeppelin IV')
  assert.equal(await view.get({ type: 'album', id: hidden.id }), null, 'a hidden music album stays hidden')
  assert.throws(() => view.scan(), /cannot scan/)
})

test('a source that cannot label books (Subsonic) is never asked for them', async (t) => {
  const abs = await fakeAbs(t)
  const music = new SubsonicAdapter({ url: 'http://127.0.0.1:9', username: 'u', password: 'p', libraryId: LIB })
  let asked = 0
  music.list = async () => { asked++; return { type: 'albums', items: [{ id: 'x', name: 'A Song Album' }], nextCursor: null } }
  const books = new AudiobookshelfAdapter({ url: abs.url, apiKey: 'key-1', libraryId: LIB })
  await books.scan()
  const c = new CombinedAdapter({ music, books })
  assert.deepEqual(names((await c.list({ type: 'albums', limit: 100, kind: 'book' })).items), ['The Book in Parts', 'The Short Book'])
  assert.equal(asked, 0)
})

test('source.json keeps a books source beside the music, without touching the music', async (t) => {
  const fsp = require('fs/promises')
  const os = require('os')
  const { SourceStore } = require('../host/source')
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-books-src-'))
  t.after(() => fsp.rm(d, { recursive: true, force: true }))

  const s = new SourceStore({ dataDir: d, musicDir: '/music' })
  s.save({ kind: 'folder', roots: ['/library/music'] })
  assert.throws(() => s.saveBooks({ kind: 'audiobookshelf' }), /address/)
  s.saveBooks({ kind: 'audiobookshelf', url: 'http://localhost:13378/', apiKey: 'k' })

  const again = new SourceStore({ dataDir: d, musicDir: '/music' })
  assert.deepEqual(again.books(), { kind: 'audiobookshelf', url: 'http://localhost:13378', apiKey: 'k' })
  assert.deepEqual(again.booksView(), { kind: 'audiobookshelf', url: 'http://localhost:13378', username: '', hasApiKey: true, hasPassword: false })
  assert.deepEqual(again.active().roots, ['/library/music'], 'the music source is unchanged')
  // An empty key from the form keeps the saved one.
  assert.equal(again.booksWithKeptSecrets({ kind: 'audiobookshelf', url: 'http://x' }).apiKey, 'k')

  again.save({ kind: 'folder', roots: ['/library/music', '/library/more'] })
  assert.equal(new SourceStore({ dataDir: d, musicDir: '/music' }).books().apiKey, 'k', 'saving the music keeps the books source')
  again.removeBooks()
  assert.equal(new SourceStore({ dataDir: d, musicDir: '/music' }).books(), null)
})
