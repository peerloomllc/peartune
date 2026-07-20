'use strict'

// Fetching a host's FULL catalog and serving the merged index from memory (multi-host step 2,
// proposal 2026-07-19).
//
// The merge itself - dedup keys, buildIndex, sort/filter/bestCopy - lives in worklet/merge.js and
// is pure. THIS module is the "pull everything once, then serve pages from RAM" half:
//   - fetchAllPages: loop a host's paginated list to exhaustion (cursor -> nextCursor -> null)
//   - fetchCatalog:  pull a host's artists/albums/tracks/genres into ONE tagged catalog
//   - paginate / serveList / searchIndex: answer the app's browse/search calls from the built index
//
// fetchAllPages and the serve helpers take a page-fetching function (or the data) as arguments, so
// they are PURE and unit-tested without a network. The loop's TERMINATION and the in-memory
// pagination are exactly where a bug would hide - a nextCursor that never nulls would spin a rebuild
// forever, an off-by-one would drop or duplicate a page's worth of songs.

const merge = require('./merge')

// Loop a single-page list function to exhaustion. `listOnePage({ cursor, limit })` resolves to the
// wire's library.list shape - { items, nextCursor } - and we follow nextCursor until it's null (or
// absent). Two backstops beyond the null: a maxPages CAP (a host whose nextCursor never nulls can't
// wedge a rebuild - personal libraries are thousands of tracks, so maxPages * limit dwarfs any real
// catalog), and a no-advance guard (a cursor that repeats or moves backwards ends the loop rather
// than re-fetching the same page).
async function fetchAllPages (listOnePage, { limit = 200, maxPages = 1000 } = {}) {
  const out = []
  let cursor = 0
  for (let page = 0; page < maxPages; page++) {
    const res = await listOnePage({ cursor, limit })
    const items = (res && res.items) || []
    for (const it of items) out.push(it)
    const next = res ? res.nextCursor : null
    if (next == null) break // the host says there's no more
    if (typeof next === 'number' && typeof cursor === 'number' && next <= cursor) break // won't advance
    if (next === cursor) break
    cursor = next
  }
  return out
}

// Pull a host's ENTIRE catalog (every artist/album/track/genre) into one bundle for the merge.
// artists/genres come back in a single page (the adapters return them whole, nextCursor null);
// albums/tracks paginate, so each is looped to exhaustion. A type a host doesn't support just
// yields [] (the adapters answer an unknown type with an empty page, they don't throw). A real
// failure - the connection dropping mid-fetch - rejects, so the caller's allSettled drops the whole
// host from the blend rather than merging a half-catalog. buildIndex tags each entity with its
// libraryId, so we carry the id here but don't stamp entities.
async function fetchCatalog (client, libraryId, { limit = 200 } = {}) {
  const pull = (type) => fetchAllPages(
    (params) => client.list({ type, cursor: params.cursor, limit: params.limit }),
    { limit }
  )
  const [artists, albums, tracks, genres] = await Promise.all([
    pull('artists'), pull('albums'), pull('tracks'), pull('genres')
  ])
  return { libraryId, artists, albums, tracks, genres }
}

// Slice ONE page out of an in-memory list, returning the wire's { items, nextCursor } shape so a
// merged browse method is a drop-in for the single-host client.list. cursor is an integer offset
// (that's all the merged view needs - the array is already fully in memory). No/zero limit returns
// the whole tail (artists and genres list unpaged, exactly as single-host mode does).
function paginate (items, cursor = 0, limit) {
  const arr = items || []
  const start = Math.max(0, Number(cursor) || 0)
  if (!limit || limit <= 0) return { items: arr.slice(start), nextCursor: null }
  const end = start + limit
  return { items: arr.slice(start, end), nextCursor: end < arr.length ? end : null }
}

// Answer a browse LIST (albums/artists/tracks/genres) from the built index: narrow to the source
// (a libraryId, or '_all'/falsy for the whole blend - the source-filter chip), sort by any field,
// then slice one page. Sorting the full in-memory list is what lets the merged view order by any
// field regardless of a host's own sort capability (a host that can't sort songs by title still
// gets an A-Z Songs list here).
function serveList (items, { libraryId, sort, order, cursor = 0, limit } = {}) {
  const filtered = merge.filterByLibrary(items || [], libraryId)
  const sorted = sort ? merge.sortItems(filtered, sort, order) : filtered
  return paginate(sorted, cursor, limit)
}

// Search the merged index in memory: a case/punctuation/accent-insensitive substring match over
// each entity's normalized name/title (plus artist + album for tracks). Mirrors the host search's
// { artists, albums, tracks } shape so the merged search method is a drop-in. Every hit is already
// deduped and carries its copies, so tapping a result streams from whichever host holds it. An
// empty needle (or a query that norms to nothing, like "the") returns nothing rather than the whole
// library.
function searchIndex (index, q, { limit = 50 } = {}) {
  const needle = merge.norm(q)
  if (!needle) return { artists: [], albums: [], tracks: [] }
  const hit = (s) => merge.norm(s).includes(needle)
  return {
    artists: (index.artists || []).filter((a) => hit(a.name)).slice(0, limit),
    albums: (index.albums || []).filter((a) => hit(a.name) || hit(a.artist)).slice(0, limit),
    tracks: (index.tracks || []).filter((t) => hit(t.title) || hit(t.artist) || hit(t.album)).slice(0, limit)
  }
}

module.exports = { fetchAllPages, fetchCatalog, paginate, serveList, searchIndex }
