// Per-person folders (proposal 2026-08-31): the rule, and the folder adapter's
// narrowed view of a real fixture tree.
//
// A rule that lets one hidden track through is a security bug of the same class as
// the two inherited ones in CLAUDE.md, so every refusal surface gets its own check:
// list, get-by-id, search, counts, art and the stream bytes themselves.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const hcrypto = require('hypercore-crypto')

const { visibleTo, narrowed, normalisePaths, viewOf, emptyView, under, normalRel } = require('../host/visibility')
const { FolderAdapter } = require('../host/adapters/folder')
const { libraryId } = require('../protocol/ids')

const MUSIC = path.join(__dirname, 'fixtures', 'music')
const LIB = libraryId(hcrypto.randomBytes(32))

async function scanned () {
  const a = new FolderAdapter({ root: MUSIC, libraryId: LIB })
  await a.scan()
  return a
}

// --- the pure rules ---------------------------------------------------------

test('normalRel: one spelling for a prefix', () => {
  for (const raw of ['kids', 'kids/', '/kids/', 'kids\\', '\\kids\\']) {
    assert.equal(normalRel(raw), 'kids', raw)
  }
  assert.equal(normalRel(''), '')
  assert.equal(normalRel(null), '')
})

test('under: folder boundaries count', () => {
  const root = '/music'
  assert.equal(under({ root, rel: 'kids/Lullabies/song.mp3' }, { root, rel: 'kids' }), true)
  assert.equal(under({ root, rel: 'kids2/song.mp3' }, { root, rel: 'kids' }), false, 'kids must not cover kids2')
  assert.equal(under({ root, rel: 'anything' }, { root, rel: '' }), true, 'rel "" is the whole root')
  assert.equal(under({ root: '/other', rel: 'kids/x' }, { root, rel: 'kids' }), false, 'a different root never matches')
})

test('visibleTo: owner always, null paths always, unplaceable never', () => {
  const loc = { root: '/music', rel: 'rock/x.mp3' }
  assert.equal(visibleTo({ scope: 'owner', paths: [{ root: '/music', rel: 'kids' }] }, loc), true, 'the owner is the library')
  assert.equal(visibleTo({ scope: 'full', paths: null }, loc), true, 'null is everything - every grant until now')
  assert.equal(visibleTo({ scope: 'full', paths: [{ root: '/music', rel: 'rock' }] }, loc), true)
  assert.equal(visibleTo({ scope: 'full', paths: [{ root: '/music', rel: 'kids' }] }, loc), false)
  // The item the adapter could not place is HIDDEN from a narrowed grant - failing
  // open would make "narrow" mean "narrow, except what we could not place".
  assert.equal(visibleTo({ scope: 'full', paths: [{ root: '/music', rel: 'kids' }] }, null), false)
  assert.equal(visibleTo({ scope: 'full', paths: null }, null), true, 'an unnarrowed grant is untouched by placement')
})

test('normalisePaths: null passes, an empty list is refused, rels are normalised', () => {
  assert.equal(normalisePaths(null), null)
  assert.equal(normalisePaths(undefined), null)
  assert.throws(() => normalisePaths([]), /non-empty/)
  assert.throws(() => normalisePaths([{ rel: 'kids' }]), /root/)
  assert.deepEqual(normalisePaths([{ root: '/m', rel: '/kids/' }]), [{ root: '/m', rel: 'kids' }])
})

test('narrowed: only a real non-owner list counts', () => {
  assert.equal(narrowed({ scope: 'full', paths: [{ root: '/m', rel: 'a' }] }), true)
  assert.equal(narrowed({ scope: 'owner', paths: [{ root: '/m', rel: 'a' }] }), false)
  assert.equal(narrowed({ scope: 'full', paths: null }), false)
  assert.equal(narrowed(null), false)
})

// --- the folder adapter's narrowed view -------------------------------------

test('a narrowed view is a smaller LIBRARY: list, search, stats and derived groups all agree', async () => {
  const a = await scanned()
  const grant = { scope: 'full', paths: [{ root: MUSIC, rel: 'Led Zeppelin' }] }
  const v = viewOf(a, grant)
  assert.notEqual(v, a, 'a narrowed grant must not get the real adapter')

  const tracks = (await v.list({ type: 'tracks', limit: 1000 })).items
  assert.ok(tracks.length > 0)
  assert.ok(tracks.every(t => t.path.startsWith('Led Zeppelin/')), 'every visible track is under the prefix')

  const albums = (await v.list({ type: 'albums', limit: 1000 })).items
  assert.deepEqual(albums.map(x => x.name), ['Led Zeppelin IV'], 'only the album with visible tracks remains')

  const artists = (await v.list({ type: 'artists' })).items
  assert.deepEqual(artists.map(x => x.name), ['Led Zeppelin'])

  const stats = await v.stats()
  assert.equal(stats.tracks, tracks.length)
  assert.equal(stats.albums, 1)
  assert.equal(stats.artists, 1)

  // Search cannot reach past the prefix either.
  const hits = await v.search({ q: 'Hallelujah' })
  assert.equal(hits.tracks.length, 0)
  assert.equal((await v.search({ q: 'Black Dog' })).tracks.length, 1)
})

test('a hidden item is not one guessed id away: get, art and the stream itself refuse', async () => {
  const a = await scanned()
  const all = (await a.list({ type: 'tracks', limit: 1000 })).items
  const hidden = all.find(t => t.path.startsWith('Handel/'))
  const hiddenAlbum = (await a.list({ type: 'albums', limit: 1000 })).items.find(x => x.name === 'Messiah')

  const v = viewOf(a, { scope: 'full', paths: [{ root: MUSIC, rel: 'Led Zeppelin' }] })
  assert.equal(await v.get({ id: hidden.id }), null, 'get by a hidden id says no such track')
  assert.equal(await v.get({ id: hiddenAlbum.id, type: 'album' }), null)
  assert.equal(await v.stream({ trackId: hidden.id }), null, 'the bytes themselves are refused')
  // Messiah's cover.jpg exists on disk AND is warmed into the shared art cache by
  // the real adapter first - the gate must come before the cache.
  assert.notEqual(await a.art({ coverId: hiddenAlbum.coverId }), null, 'the fixture album really has art')
  assert.equal(await v.art({ coverId: hiddenAlbum.coverId }), null, 'a hidden album has no art, even cached')
})

test('a visible album with hidden siblings reports honest counts', async () => {
  const a = await scanned()
  // Narrow to one disc of a two-disc album: the album stays, its counts shrink.
  const v = viewOf(a, { scope: 'full', paths: [{ root: MUSIC, rel: 'Pink Floyd/The Wall/CD1' }] })
  const albums = (await v.list({ type: 'albums', limit: 1000 })).items
  assert.equal(albums.length, 1)
  const full = await v.get({ id: albums[0].id, type: 'album' })
  assert.equal(full.tracks.length, 1, 'only the visible disc\'s track')
  assert.ok(full.tracks[0].path.includes('CD1'))
})

test('the view is per grant and the real adapter is untouched', async () => {
  const a = await scanned()
  const before = (await a.list({ type: 'tracks', limit: 1000 })).items.length
  const v = viewOf(a, { scope: 'full', paths: [{ root: MUSIC, rel: 'Untagged' }] })
  assert.equal((await v.list({ type: 'tracks', limit: 1000 })).items.length, 1)
  assert.equal((await a.list({ type: 'tracks', limit: 1000 })).items.length, before, 'the wide library is unchanged')
  // The unnarrowed fast path really is the same object.
  assert.equal(viewOf(a, { scope: 'full', paths: null }), a)
  assert.equal(viewOf(a, { scope: 'owner', paths: [{ root: MUSIC, rel: 'Untagged' }] }), a, 'the owner is never filtered')
})

test('a source that cannot enforce a narrowing serves NOTHING, not everything', async () => {
  // The stand-in for a proxy adapter: no narrowedView, no canNarrow.
  const proxy = {
    kind: 'subsonic',
    libraryId: LIB,
    async stats () { return { tracks: 999 } },
    async list () { return { type: 'tracks', items: [{ id: 'x' }], nextCursor: null } },
    async get () { return { id: 'x' } },
    async search () { return { artists: [], albums: [], tracks: [{ id: 'x' }] } },
    async art () { return {} },
    async stream () { return {} }
  }
  const v = viewOf(proxy, { scope: 'full', paths: [{ root: '/m', rel: 'kids' }] })
  assert.equal((await v.list({ type: 'tracks' })).items.length, 0)
  assert.equal(await v.get({ id: 'x' }), null)
  assert.equal((await v.search({ q: 'x' })).tracks.length, 0)
  assert.equal(await v.stream({ trackId: 'x' }), null)
  assert.equal(await v.art({ coverId: 'x' }), null)
  const stats = await v.stats()
  assert.equal(stats.tracks, 0)
  assert.equal(stats.unenforceable, true)
  // And the unnarrowed path still passes the proxy through untouched.
  assert.equal(viewOf(proxy, { scope: 'full', paths: null }), proxy)
})

test('the sharing tree: roots and one level of folders, from memory', async () => {
  const a = await scanned()
  const roots = a.rootsForSharing()
  assert.equal(roots.length, 1)
  assert.equal(roots[0].root, MUSIC)
  assert.equal(roots[0].primary, true)

  const top = a.foldersUnder({ root: MUSIC, rel: '' })
  const names = top.map(f => f.name)
  assert.ok(names.includes('Led Zeppelin'))
  assert.ok(names.includes('Handel'))
  assert.ok(names.includes('Untagged'))

  const under = a.foldersUnder({ root: MUSIC, rel: 'Pink Floyd/The Wall' })
  assert.deepEqual(under.map(f => f.name).sort(), ['CD1', 'CD2'])
  for (const f of under) assert.ok(f.rel.startsWith('Pink Floyd/The Wall/'))
})

test('emptyView mirrors the adapter interface it stands in for', async () => {
  const a = await scanned()
  const e = emptyView(a)
  for (const m of ['stats', 'list', 'get', 'search', 'art', 'stream']) {
    assert.equal(typeof e[m], 'function', m)
  }
  assert.equal(e.kind, a.kind)
})
