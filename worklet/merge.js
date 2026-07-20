'use strict'

// The merged, deduplicated library index (multi-host step 2, proposal 2026-07-19).
//
// Given each paired host's FULL catalog (tagged with its libraryId), produce ONE blended,
// deduped index the worklet serves browse/search/sort from in memory. PearTune targets
// personal-scale libraries, so "fetch everything once and merge in memory" sidesteps the
// un-expressible paginated cross-host merge-sort - and lets us sort by any field regardless of
// a host's own sort capability.
//
// Everything here is PURE (no fs, no network), because the dedup is LOSSY and its keying is the
// one part that most needs exhaustive unit tests: a real re-rip with different tags must not
// silently collapse, and a punctuation/"feat." variant of the same song must.
//
// A merged entity keeps EVERY host copy (`copies[]`, primary first) so streaming can fail over
// to another host when the primary is offline - the dedup is robust, not brittle. trackId is a
// one-way hash, so the owning libraryId travels on every copy; nothing routes without it.

// --- normalization + dedup keys ---------------------------------------------

// Fold a name to its dedup form: lowercase, strip accents + punctuation, drop a leading "the",
// drop a trailing "(feat ...)" / "[remaster]"-style qualifier, collapse whitespace. The same
// idea the folder adapter uses to group albums and genres use to merge case.
function norm (s) {
  if (s == null) return ''
  let x = String(s).toLowerCase()
  x = x.normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip accents
  x = x.replace(/\b(feat|ft|featuring)\b[.\s].*$/i, ' ') // drop a featured-artist tail
  // drop an edition/remaster qualifier in brackets ("(2011 Remaster)", "[Deluxe Edition]")
  x = x.replace(/[([][^)\]]*(remaster|deluxe|edition|version|mono|stereo|expanded|bonus|anniversary)[^)\]]*[)\]]/gi, ' ')
  x = x.replace(/[^a-z0-9]+/g, ' ').trim() // punctuation -> space
  x = x.replace(/^the /, '') // leading article
  return x.replace(/\s+/g, ' ').trim()
}

// Duration rounding (ms), so a couple of seconds' difference between two rips of the same song
// still matches. Small enough that genuinely different tracks of similar length keep their own
// key once artist+album+track# are also in the mix.
const DUR_BUCKET_MS = 3000

function trackKey (t) {
  const dur = Math.round((Number(t.durationMs) || 0) / DUR_BUCKET_MS)
  return [norm(t.artist), norm(t.album), Number(t.track) || 0, dur].join('|')
}

function albumKey (a) {
  return [norm(a.albumartist || a.artist), norm(a.name), Number(a.year) || 0].join('|')
}

function artistKey (a) {
  return norm(a.name)
}

function genreKey (g) {
  return norm(g.name)
}

// --- merge primitives -------------------------------------------------------

// Group tagged entities by a dedup key. Each group keeps its member `copies` (in first-seen
// order) and a chosen `primary` (whose display fields win). `better(a, b)` returns true when a
// should replace b as primary; default keeps the first seen (i.e. the first-added host).
function groupByKey (entities, keyFn, better) {
  const byKey = new Map()
  for (const e of entities) {
    const k = keyFn(e)
    let g = byKey.get(k)
    if (!g) { g = { key: k, primary: e, copies: [e] }; byKey.set(k, g); continue }
    g.copies.push(e)
    if (better && better(e, g.primary)) g.primary = e
  }
  return byKey
}

// copies[] with the PRIMARY first, so bestCopy() (and any "which server" UI) reads primary as
// the head and the rest as fallbacks in first-seen order.
function orderedCopies (group, copyOf) {
  const p = copyOf(group.primary)
  const rest = group.copies.filter((e) => e !== group.primary).map(copyOf)
  return [p, ...rest]
}

const isLossless = (suffix) => /^(flac|alac|wav|aiff|ape|wv)$/i.test(String(suffix || ''))

// A better track copy to be PRIMARY: prefer lossless, then larger file (a rough bitrate proxy).
// This is only about which copy we default to streaming; every copy stays reachable.
function betterTrack (a, b) {
  if (isLossless(a.suffix) !== isLossless(b.suffix)) return isLossless(a.suffix)
  return (Number(a.size) || 0) > (Number(b.size) || 0)
}

function trackCopy (t) {
  return {
    libraryId: t.libraryId,
    id: t.id,
    coverId: t.coverId,
    suffix: t.suffix || null,
    size: Number(t.size) || 0
  }
}

function idCopy (x) {
  return { libraryId: x.libraryId, id: x.id, coverId: x.coverId }
}

// --- per-type merges --------------------------------------------------------

function mergeTracks (tracks) {
  const out = []
  for (const g of groupByKey(tracks, trackKey, betterTrack).values()) {
    const p = g.primary
    out.push({
      id: p.id,
      key: g.key,
      libraryId: p.libraryId,
      title: p.title,
      artist: p.artist,
      album: p.album,
      track: Number(p.track) || 0,
      year: Number(p.year) || 0,
      durationMs: Number(p.durationMs) || 0,
      coverId: p.coverId,
      copies: orderedCopies(g, trackCopy)
    })
  }
  return out
}

// The most complete album copy wins primary (most songs), a decent proxy for "the good rip".
function mergeAlbums (albums) {
  const better = (a, b) => (Number(a.songCount) || 0) > (Number(b.songCount) || 0)
  const out = []
  for (const g of groupByKey(albums, albumKey, better).values()) {
    const p = g.primary
    out.push({
      id: p.id,
      key: g.key,
      libraryId: p.libraryId,
      name: p.name,
      artist: p.artist,
      year: Number(p.year) || 0,
      coverId: p.coverId,
      songCount: Math.max(...g.copies.map((c) => Number(c.songCount) || 0)),
      copies: orderedCopies(g, idCopy)
    })
  }
  return out
}

function mergeArtists (artists) {
  const out = []
  for (const g of groupByKey(artists, artistKey).values()) {
    const p = g.primary
    out.push({
      id: p.id,
      key: g.key,
      libraryId: p.libraryId,
      name: p.name,
      coverId: p.coverId,
      albumCount: Number(p.albumCount) || 0, // recomputed from merged albums in buildIndex
      copies: orderedCopies(g, idCopy)
    })
  }
  return out
}

function mergeGenres (genres) {
  const out = []
  for (const g of groupByKey(genres, genreKey).values()) {
    const p = g.primary
    out.push({
      id: p.id,
      key: g.key,
      libraryId: p.libraryId,
      name: p.name,
      coverId: p.coverId,
      copies: orderedCopies(g, idCopy)
    })
  }
  return out
}

// --- the index --------------------------------------------------------------

// Build the merged index from per-host catalogs. Each catalog is
// { libraryId, artists, albums, tracks, genres } (any list may be missing). Entities are tagged
// with their libraryId, merged by dedup key, and artist.albumCount is recomputed from the
// DEDUPED album set so it reflects the blended library, not one host's count.
function buildIndex (catalogs) {
  const list = Array.isArray(catalogs) ? catalogs : []
  const tag = (arr, libraryId) => (Array.isArray(arr) ? arr : []).map((x) => ({ ...x, libraryId }))
  const collect = (field) => list.flatMap((c) => tag(c && c[field], c && c.libraryId))

  const tracks = mergeTracks(collect('tracks'))
  const albums = mergeAlbums(collect('albums'))
  const artists = mergeArtists(collect('artists'))
  const genres = mergeGenres(collect('genres'))

  const albumsPerArtist = new Map()
  for (const a of albums) {
    const k = norm(a.artist)
    albumsPerArtist.set(k, (albumsPerArtist.get(k) || 0) + 1)
  }
  for (const ar of artists) {
    const c = albumsPerArtist.get(norm(ar.name))
    if (c != null) ar.albumCount = c
  }

  return { artists, albums, tracks, genres }
}

// --- serve helpers ----------------------------------------------------------

// Sort merged items by a field, in place-safe (returns a new array). Text fields sort by their
// normalized form so "The Beatles" and "beatles" order together. Unknown key -> name/title.
function sortItems (items, key, order = 'asc') {
  const dir = order === 'desc' ? -1 : 1
  const val = (x) => {
    switch (key) {
      case 'year': return Number(x.year) || 0
      case 'duration': return Number(x.durationMs) || 0
      case 'artist': return norm(x.artist)
      case 'album': return norm(x.album)
      case 'title': return norm(x.title != null ? x.title : x.name)
      case 'name': return norm(x.name != null ? x.name : x.title)
      default: return norm(x.name != null ? x.name : x.title)
    }
  }
  return [...(items || [])].sort((a, b) => {
    const av = val(a)
    const bv = val(b)
    return av < bv ? -dir : av > bv ? dir : 0
  })
}

// Narrow the merged list to items with a copy on `libraryId`. '_all'/falsy = the whole blend
// (the source-filter chip). This is why the per-host view is free: it's just the merged index
// filtered.
function filterByLibrary (items, libraryId) {
  if (!libraryId || libraryId === '_all') return items || []
  return (items || []).filter(
    (x) => (Array.isArray(x.copies) && x.copies.some((c) => c.libraryId === libraryId)) || x.libraryId === libraryId
  )
}

// The best copy to STREAM: the primary if its host is connected, else the first connected
// fallback, else the primary anyway (caller will get a connect error / greyed track). `connected`
// is a Set of libraryIds currently reachable; omit to just take the primary.
function bestCopy (entity, connected) {
  if (!entity) return null
  const copies = Array.isArray(entity.copies) && entity.copies.length
    ? entity.copies
    : (entity.libraryId ? [{ libraryId: entity.libraryId, id: entity.id, coverId: entity.coverId }] : [])
  if (!copies.length) return null
  if (!connected) return copies[0]
  return copies.find((c) => connected.has(c.libraryId)) || copies[0]
}

module.exports = {
  norm,
  trackKey,
  albumKey,
  artistKey,
  genreKey,
  mergeTracks,
  mergeAlbums,
  mergeArtists,
  mergeGenres,
  buildIndex,
  sortItems,
  filterByLibrary,
  bestCopy,
  DUR_BUCKET_MS
}
