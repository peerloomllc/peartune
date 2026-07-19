// Shared library-sort contract.
//
// Sorting the library is source-agnostic in its VOCABULARY but not in its cost. A
// folder holds the whole library in memory, so it sorts any field for free; Jellyfin
// sorts server-side via SortBy; and Subsonic can sort albums (getAlbumList2 has a
// handful of orderings) but has NO all-songs sort at all (empty-query search3 takes
// no order param). So each adapter advertises what it can actually do in
// stats().sorts, and the client only shows a control a source can honor. Folder is
// the primary case and gets the full set; the rest degrade honestly.
//
// The KEYS are canonical and source-agnostic ('title', 'artist', ...); each adapter
// maps them to its own server's language. `order` is 'asc' | 'desc'. Passing no sort
// leaves a view in its existing default order (shelf order), so this is additive -
// an old client that never sends `sort` sees exactly the behavior it always did.

const collator = (a, b) =>
  String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base', numeric: true })
const num = (a, b) => (a ?? 0) - (b ?? 0)

// Comparators over the adapters' INTERNAL row shapes (title/artist/album/year/
// durationMs for a track; name/artist/year for an album). Ties break toward the
// shelf order a person expects - by artist then album then track for songs - so a
// sort by year does not scramble the tracks within a year.
const TRACK_CMP = {
  title: (a, b) => collator(a.title, b.title) || collator(a.artist, b.artist),
  artist: (a, b) => collator(a.artist, b.artist) || collator(a.album, b.album) || num(a.disc, b.disc) || num(a.track, b.track),
  album: (a, b) => collator(a.album, b.album) || num(a.disc, b.disc) || num(a.track, b.track),
  year: (a, b) => num(a.year, b.year) || collator(a.album, b.album) || num(a.disc, b.disc) || num(a.track, b.track),
  duration: (a, b) => num(a.durationMs, b.durationMs) || collator(a.title, b.title)
}
const ALBUM_CMP = {
  name: (a, b) => collator(a.name, b.name),
  artist: (a, b) => collator(a.artist, b.artist) || collator(a.name, b.name),
  year: (a, b) => num(a.year, b.year) || collator(a.name, b.name),
  // Newest first is the useful direction, so ascending 'added' means most-recent; the
  // client asks for it as {sort:'added', order:'desc'} to get newest-on-top explicitly.
  added: (a, b) => num(a.addedAt, b.addedAt) || collator(a.name, b.name)
}
const ARTIST_CMP = {
  name: (a, b) => collator(a.name, b.name)
}
const GENRE_CMP = {
  name: (a, b) => collator(a.name, b.name)
}

// The capability a source with in-memory or fully server-sortable data advertises:
// every canonical key, reversible in both directions. Folder and Jellyfin use this.
const FULL_SORTS = {
  tracks: { keys: ['title', 'artist', 'album', 'year', 'duration'], reversible: true },
  albums: { keys: ['name', 'artist', 'year', 'added'], reversible: true },
  artists: { keys: ['name'], reversible: true },
  genres: { keys: ['name'], reversible: true }
}

// In-memory sort of `rows` by a canonical key. An unknown or absent key returns the
// array UNCHANGED (the caller's default order), so no-sort is always a no-op. `desc`
// negates the comparator rather than reversing the array, so equal rows keep their
// stable tie-break order in both directions.
function sortRows (rows, table, sort, order) {
  const base = table[sort]
  if (!base) return rows
  const dir = order === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => dir * base(a, b))
}

module.exports = { TRACK_CMP, ALBUM_CMP, ARTIST_CMP, GENRE_CMP, FULL_SORTS, sortRows, collator }
