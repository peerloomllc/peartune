// The shared library-sort contract.
//
// Pure comparators and the capability descriptor every adapter advertises. Kept
// separate and brute-forceable (like host/gate.js's decide() and app/queue-index.js)
// because a sort that scrambles ties or forgets a direction is the kind of bug that
// looks fine on one library and wrong on the next.

const test = require('node:test')
const assert = require('node:assert/strict')

const { TRACK_CMP, ALBUM_CMP, ARTIST_CMP, FULL_SORTS, sortRows } = require('../host/adapters/sort')

const TRACKS = [
  { title: 'Aerials', artist: 'System of a Down', album: 'Toxicity', year: 2001, disc: 1, track: 14, durationMs: 235000 },
  { title: 'Chop Suey!', artist: 'System of a Down', album: 'Toxicity', year: 2001, disc: 1, track: 6, durationMs: 210000 },
  { title: 'B.Y.O.B.', artist: 'System of a Down', album: 'Mezmerize', year: 2005, disc: 1, track: 3, durationMs: 255000 },
  { title: 'Zebra', artist: 'ABBA', album: 'Arrival', year: 1976, disc: 1, track: 1, durationMs: 180000 }
]
const titles = rows => rows.map(t => t.title)

test('unknown or absent key leaves the array untouched (default order is a no-op)', () => {
  assert.equal(sortRows(TRACKS, TRACK_CMP, undefined, 'asc'), TRACKS)
  assert.equal(sortRows(TRACKS, TRACK_CMP, 'nonsense', 'asc'), TRACKS)
})

test('title sorts ascending, and desc is the exact reverse ordering', () => {
  const asc = sortRows(TRACKS, TRACK_CMP, 'title', 'asc')
  assert.deepEqual(titles(asc), ['Aerials', 'B.Y.O.B.', 'Chop Suey!', 'Zebra'])
  const desc = sortRows(TRACKS, TRACK_CMP, 'title', 'desc')
  assert.deepEqual(titles(desc), ['Zebra', 'Chop Suey!', 'B.Y.O.B.', 'Aerials'])
})

test('year is numeric (not "2001" < "205"), and ties break to shelf order', () => {
  const asc = sortRows(TRACKS, TRACK_CMP, 'year', 'asc')
  assert.deepEqual(asc.map(t => t.year), [1976, 2001, 2001, 2005])
  // The two 2001 Toxicity tracks keep album/disc/track order: track 6 before 14.
  const toxicity = asc.filter(t => t.year === 2001)
  assert.deepEqual(titles(toxicity), ['Chop Suey!', 'Aerials'])
})

test('duration sorts by length numerically', () => {
  const asc = sortRows(TRACKS, TRACK_CMP, 'duration', 'asc')
  assert.deepEqual(asc.map(t => t.durationMs), [180000, 210000, 235000, 255000])
})

test('artist sort groups an artist together then orders by album/track', () => {
  const asc = sortRows(TRACKS, TRACK_CMP, 'artist', 'asc')
  // ABBA first, then all System of a Down; within SOaD, Mezmerize before Toxicity.
  assert.deepEqual(titles(asc), ['Zebra', 'B.Y.O.B.', 'Chop Suey!', 'Aerials'])
})

test('sortRows does not mutate the input', () => {
  const before = titles(TRACKS)
  sortRows(TRACKS, TRACK_CMP, 'title', 'desc')
  assert.deepEqual(titles(TRACKS), before)
})

test('album comparator orders by name then year; artist comparator by name', () => {
  const albums = [
    { name: 'Toxicity', artist: 'System of a Down', year: 2001 },
    { name: 'Arrival', artist: 'ABBA', year: 1976 },
    { name: 'Mezmerize', artist: 'System of a Down', year: 2005 }
  ]
  assert.deepEqual(sortRows(albums, ALBUM_CMP, 'name', 'asc').map(a => a.name), ['Arrival', 'Mezmerize', 'Toxicity'])
  assert.deepEqual(sortRows(albums, ALBUM_CMP, 'year', 'asc').map(a => a.year), [1976, 2001, 2005])
  const artists = [{ name: 'System of a Down' }, { name: 'ABBA' }]
  assert.deepEqual(sortRows(artists, ARTIST_CMP, 'name', 'asc').map(a => a.name), ['ABBA', 'System of a Down'])
})

test('FULL_SORTS advertises every canonical key, reversible, per view', () => {
  assert.deepEqual(FULL_SORTS.tracks.keys, ['title', 'artist', 'album', 'year', 'duration'])
  assert.deepEqual(FULL_SORTS.albums.keys, ['name', 'artist', 'year'])
  assert.deepEqual(FULL_SORTS.artists.keys, ['name'])
  for (const v of ['tracks', 'albums', 'artists']) assert.equal(FULL_SORTS[v].reversible, true)
  // Every advertised key must have a real comparator behind it, or the control lies.
  for (const k of FULL_SORTS.tracks.keys) assert.equal(typeof TRACK_CMP[k], 'function')
  for (const k of FULL_SORTS.albums.keys) assert.equal(typeof ALBUM_CMP[k], 'function')
  for (const k of FULL_SORTS.artists.keys) assert.equal(typeof ARTIST_CMP[k], 'function')
})
