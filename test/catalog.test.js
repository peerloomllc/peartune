// Pulling a host's full catalog and serving the merged index from memory (multi-host step 2,
// proposal 2026-07-19). The pure bits worth pinning: fetchAllPages TERMINATES (on null, on a cap,
// on a non-advancing cursor) and accumulates every page; paginate slices exact boundaries;
// serveList composes filter+sort+page; searchIndex matches across normalized fields.

const test = require('node:test')
const assert = require('node:assert/strict')
const C = require('../worklet/catalog')
const M = require('../worklet/merge')

// --- fetchAllPages: the pagination loop --------------------------------------

// A fake host list: `all` items handed out `limit` at a time, numeric offset cursor, nextCursor
// null on the last page - exactly the adapters' shape (subsonic/folder/jellyfin).
function pager (all) {
  return async ({ cursor, limit }) => {
    const start = Number(cursor) || 0
    const items = all.slice(start, start + limit)
    const end = start + limit
    return { items, nextCursor: end < all.length ? end : null }
  }
}

test('fetchAllPages walks every page and stops at nextCursor null', async () => {
  const all = Array.from({ length: 250 }, (_, i) => ({ id: i }))
  const got = await C.fetchAllPages(pager(all), { limit: 100 })
  assert.equal(got.length, 250)
  assert.deepEqual(got.map((x) => x.id), all.map((x) => x.id))
})

test('fetchAllPages handles a single-page list (nextCursor null on the first page)', async () => {
  const all = [{ id: 'a' }, { id: 'b' }]
  const got = await C.fetchAllPages(pager(all), { limit: 100 })
  assert.deepEqual(got, all)
})

test('fetchAllPages returns [] for an empty catalog', async () => {
  assert.deepEqual(await C.fetchAllPages(pager([]), { limit: 50 }), [])
})

test('fetchAllPages is bounded by maxPages when a host never nulls its cursor', async () => {
  let calls = 0
  const runaway = async ({ cursor }) => { calls++; return { items: [{ cursor }], nextCursor: cursor + 1 } }
  const got = await C.fetchAllPages(runaway, { limit: 1, maxPages: 5 })
  assert.equal(calls, 5, 'stops at the cap, does not spin forever')
  assert.equal(got.length, 5)
})

test('fetchAllPages stops when the cursor does not advance', async () => {
  let calls = 0
  const stuck = async () => { calls++; return { items: [{}], nextCursor: 0 } } // always offset 0
  const got = await C.fetchAllPages(stuck, { limit: 10, maxPages: 100 })
  assert.equal(calls, 1, 'a cursor that returns to 0 ends the loop')
  assert.equal(got.length, 1)
})

// --- fetchCatalog: pulling all four lists off a client -----------------------

test('fetchCatalog pulls artists/albums/tracks/genres to exhaustion and tags the libraryId', async () => {
  const fixtures = {
    artists: [{ id: 'ar1', name: 'A' }],
    albums: Array.from({ length: 3 }, (_, i) => ({ id: 'al' + i })),
    tracks: Array.from({ length: 5 }, (_, i) => ({ id: 't' + i })),
    genres: [{ id: 'g1', name: 'Rock' }]
  }
  const client = {
    list: async ({ type, cursor, limit }) => {
      const all = fixtures[type] || []
      const start = Number(cursor) || 0
      const end = start + limit
      return { type, items: all.slice(start, end), nextCursor: end < all.length ? end : null }
    }
  }
  const cat = await C.fetchCatalog(client, 'libX', { limit: 2 })
  assert.equal(cat.libraryId, 'libX')
  assert.equal(cat.artists.length, 1)
  assert.equal(cat.albums.length, 3)
  assert.equal(cat.tracks.length, 5, 'tracks paged 2 at a time, all 5 collected')
  assert.equal(cat.genres.length, 1)
})

test('fetchCatalog rejects when a list call fails (so the caller drops the whole host)', async () => {
  const client = { list: async ({ type }) => { if (type === 'tracks') throw new Error('dropped'); return { items: [], nextCursor: null } } }
  await assert.rejects(() => C.fetchCatalog(client, 'libX'), /dropped/)
})

// --- paginate ----------------------------------------------------------------

test('paginate slices exact boundaries and reports the next cursor', () => {
  const items = Array.from({ length: 10 }, (_, i) => i)
  assert.deepEqual(C.paginate(items, 0, 4), { items: [0, 1, 2, 3], nextCursor: 4 })
  assert.deepEqual(C.paginate(items, 4, 4), { items: [4, 5, 6, 7], nextCursor: 8 })
  assert.deepEqual(C.paginate(items, 8, 4), { items: [8, 9], nextCursor: null }, 'last partial page has no next')
  assert.deepEqual(C.paginate(items, 0, 0).nextCursor, null, 'no limit -> whole tail, no next')
  assert.deepEqual(C.paginate(items, 0, 0).items.length, 10)
})

// --- serveList: filter + sort + page over the built index --------------------

const umbrel = {
  libraryId: 'libU',
  albums: [
    { id: 'u1', name: 'OK Computer', artist: 'Radiohead', year: 1997, songCount: 12 },
    { id: 'u2', name: 'Kid A', artist: 'Radiohead', year: 2000, songCount: 10 }
  ],
  artists: [{ id: 'uar', name: 'Radiohead' }],
  tracks: [{ id: 'ut1', title: 'Airbag', artist: 'Radiohead', album: 'OK Computer', track: 1, durationMs: 284000, suffix: 'mp3', size: 6800000 }],
  genres: [{ id: 'ug', name: 'Rock' }]
}
const mac = {
  libraryId: 'libM',
  albums: [{ id: 'm1', name: 'OK Computer (2011 Remaster)', artist: 'radiohead', year: 1997, songCount: 15 }],
  artists: [{ id: 'mar', name: 'Radiohead' }],
  tracks: [{ id: 'mt1', title: 'Airbag', artist: 'Radiohead', album: 'OK Computer', track: 1, durationMs: 285000, suffix: 'flac', size: 30000000 }],
  genres: [{ id: 'mg', name: 'rock' }]
}

test('serveList sorts the whole blend by any field then pages it', () => {
  const ix = M.buildIndex([umbrel, mac])
  const page = C.serveList(ix.albums, { sort: 'name', order: 'asc', cursor: 0, limit: 1 })
  // Deduped: OK Computer (merged) + Kid A = 2 albums; sorted by name Kid A < OK Computer
  assert.equal(page.items[0].name.startsWith('Kid A'), true)
  assert.equal(page.nextCursor, 1)
  const rest = C.serveList(ix.albums, { sort: 'name', cursor: 1, limit: 1 })
  assert.equal(M.norm(rest.items[0].name).startsWith('ok computer'), true)
  assert.equal(rest.nextCursor, null)
})

test('serveList narrows to one source (the filter chip), keeping every returned item tagged', () => {
  const ix = M.buildIndex([umbrel, mac])
  const onlyMac = C.serveList(ix.albums, { libraryId: 'libM' })
  assert.ok(onlyMac.items.every((a) => a.copies.some((c) => c.libraryId === 'libM')))
  assert.ok(!onlyMac.items.some((a) => a.name === 'Kid A'), 'Kid A is Umbrel-only, excluded from the Mac filter')
})

// --- searchIndex -------------------------------------------------------------

test('searchIndex matches across normalized name/title/artist/album, deduped, with copies', () => {
  const ix = M.buildIndex([umbrel, mac])
  const r = C.searchIndex(ix, 'airbag')
  assert.equal(r.tracks.length, 1, 'the two hosts\' Airbag is one deduped hit')
  assert.deepEqual(r.tracks[0].copies.map((c) => c.libraryId), ['libM', 'libU'])
  // "computer" hits the album by name; punctuation/case fold away
  assert.equal(C.searchIndex(ix, 'COMPUTER').albums.length, 1)
  // artist search finds Radiohead by an album's artist field too
  assert.ok(C.searchIndex(ix, 'radiohead').artists.length >= 1)
})

test('searchIndex returns nothing for an empty or norm-empty query', () => {
  const ix = M.buildIndex([umbrel, mac])
  assert.deepEqual(C.searchIndex(ix, ''), { artists: [], albums: [], tracks: [] })
  assert.deepEqual(C.searchIndex(ix, 'the'), { artists: [], albums: [], tracks: [] }, '"the" norms away')
})

test('searchIndex caps each list at the limit', () => {
  const many = { artists: Array.from({ length: 100 }, (_, i) => ({ id: 'a' + i, name: 'Band ' + i })), albums: [], tracks: [] }
  assert.equal(C.searchIndex(many, 'band', { limit: 10 }).artists.length, 10)
})
