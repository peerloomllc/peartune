// The merged, deduped library index (multi-host step 2, proposal 2026-07-19). The dedup is
// LOSSY, so what's worth pinning: the SAME song on two hosts collapses to one entry keeping
// both copies (primary first), a genuine re-rip of a DIFFERENT length does NOT collapse, and a
// punctuation/"feat."/remaster variant of the same song DOES. Plus: sort by any field, the
// per-host filter, and best-connected-copy failover.

const test = require('node:test')
const assert = require('node:assert/strict')
const M = require('../worklet/merge')

// --- norm --------------------------------------------------------------------

test('norm folds case, punctuation, accents, leading "the", and feat/remaster tails', () => {
  assert.equal(M.norm('The Beatles'), 'beatles')
  assert.equal(M.norm('Beyoncé'), 'beyonce')
  assert.equal(M.norm('Sgt. Pepper’s!'), 'sgt pepper s')
  assert.equal(M.norm('OK Computer (2011 Remaster)'), 'ok computer')
  assert.equal(M.norm('Umbrella (feat. Jay-Z)'), 'umbrella')
  assert.equal(M.norm('  Radiohead  '), 'radiohead')
  assert.equal(M.norm(null), '')
})

// --- track dedup keying ------------------------------------------------------

const trk = (o) => ({ title: 'X', artist: 'A', album: 'B', track: 1, durationMs: 200000, ...o })

test('the same song matches across punctuation / feat / accent / remaster variants', () => {
  const a = trk({ artist: 'Beyoncé', album: 'Lemonade', title: 'Sorry' })
  const b = trk({ artist: 'Beyonce', album: 'Lemonade (Deluxe Edition)', title: 'Sorry (feat. someone)' })
  assert.equal(M.trackKey(a), M.trackKey(b))
})

test('a duration difference within the bucket still matches; a real re-rip of different length does NOT', () => {
  assert.equal(M.trackKey(trk({ durationMs: 200000 })), M.trackKey(trk({ durationMs: 201500 })))
  assert.notEqual(M.trackKey(trk({ durationMs: 200000 })), M.trackKey(trk({ durationMs: 240000 })))
})

test('different track numbers or albums keep distinct keys', () => {
  assert.notEqual(M.trackKey(trk({ track: 1 })), M.trackKey(trk({ track: 2 })))
  assert.notEqual(M.trackKey(trk({ album: 'B' })), M.trackKey(trk({ album: 'C' })))
})

// --- buildIndex: the merge ---------------------------------------------------

const umbrel = {
  libraryId: 'libU',
  artists: [{ id: 'u-ar', name: 'Radiohead', coverId: 'uc0', albumCount: 5 }],
  albums: [
    { id: 'u-al1', name: 'OK Computer', artist: 'Radiohead', year: 1997, coverId: 'uc1', songCount: 12 },
    { id: 'u-al2', name: 'Kid A', artist: 'Radiohead', year: 2000, coverId: 'uc2', songCount: 10 }
  ],
  tracks: [
    { id: 'u-t1', title: 'Airbag', artist: 'Radiohead', album: 'OK Computer', track: 1, year: 1997, durationMs: 284000, coverId: 'uc1', suffix: 'mp3', size: 6800000 }
  ],
  genres: [{ id: 'u-g1', name: 'Rock', coverId: 'uc1' }]
}
const mac = {
  libraryId: 'libM',
  artists: [{ id: 'm-ar', name: 'The Radiohead', coverId: 'mc0', albumCount: 1 }], // "The " folds -> same artist
  albums: [
    // Same album as Umbrel's OK Computer, remaster-tagged + more complete -> should merge, Mac
    // primary (more songs). (A qualifier norm strips: "(2011 Remaster)". A NON-standard suffix
    // like "(OKNOTOK)" is a genuinely different reissue and deliberately does NOT merge.)
    { id: 'm-al1', name: 'OK Computer (2011 Remaster)', artist: 'radiohead', year: 1997, coverId: 'mc1', songCount: 15 }
  ],
  tracks: [
    // Same Airbag, lossless -> merges with Umbrel's, Mac becomes primary (lossless)
    { id: 'm-t1', title: 'Airbag', artist: 'Radiohead', album: 'OK Computer', track: 1, year: 1997, durationMs: 285000, coverId: 'mc1', suffix: 'flac', size: 30000000 }
  ],
  genres: [{ id: 'm-g1', name: 'rock', coverId: 'mc1' }]
}

test('buildIndex merges the same album across hosts, keeping both copies (primary = most complete)', () => {
  const ix = M.buildIndex([umbrel, mac])
  const ok = ix.albums.filter((a) => M.norm(a.name).startsWith('ok computer'))
  assert.equal(ok.length, 1, 'OK Computer appears once, not twice')
  const merged = ok[0]
  assert.equal(merged.libraryId, 'libM', 'the more-complete (Mac) copy is primary')
  assert.equal(merged.songCount, 15, 'songCount is the max across copies')
  assert.deepEqual(merged.copies.map((c) => c.libraryId), ['libM', 'libU'], 'both copies kept, primary first')
})

test('buildIndex merges a track across hosts, primary = lossless, both copies retained', () => {
  const ix = M.buildIndex([umbrel, mac])
  const airbags = ix.tracks.filter((t) => t.title === 'Airbag')
  assert.equal(airbags.length, 1)
  const t = airbags[0]
  assert.equal(t.libraryId, 'libM', 'lossless (Mac flac) is primary')
  assert.deepEqual(t.copies.map((c) => c.libraryId), ['libM', 'libU'])
  assert.equal(t.copies[0].suffix, 'flac')
})

test('buildIndex folds "The Radiohead" into "Radiohead" and recomputes albumCount from merged albums', () => {
  const ix = M.buildIndex([umbrel, mac])
  const radios = ix.artists.filter((a) => M.norm(a.name) === 'radiohead')
  assert.equal(radios.length, 1, 'one Radiohead, not two')
  // merged albums under Radiohead: OK Computer (merged) + Kid A = 2
  assert.equal(radios[0].albumCount, 2, 'albumCount reflects the deduped album set')
  assert.deepEqual(radios[0].copies.map((c) => c.libraryId), ['libU', 'libM'])
})

test('buildIndex merges genres case-insensitively', () => {
  const ix = M.buildIndex([umbrel, mac])
  assert.equal(ix.genres.filter((g) => M.norm(g.name) === 'rock').length, 1)
})

test('buildIndex tolerates a host with missing lists and an empty catalog set', () => {
  assert.deepEqual(M.buildIndex([]), { artists: [], albums: [], tracks: [], genres: [] })
  const ix = M.buildIndex([{ libraryId: 'x', albums: [{ id: 'a', name: 'Solo', artist: 'Q', year: 0, songCount: 1 }] }])
  assert.equal(ix.albums.length, 1)
  assert.equal(ix.tracks.length, 0)
})

// --- sort / filter / bestCopy ------------------------------------------------

test('mergeAlbums keeps the NEWEST addedAt across copies, and sortItems orders by it', () => {
  const a = [
    { id: 'u', libraryId: 'libU', name: 'OK Computer', artist: 'Radiohead', year: 1997, songCount: 12, addedAt: 1000 },
    { id: 'm', libraryId: 'libM', name: 'OK Computer', artist: 'Radiohead', year: 1997, songCount: 12, addedAt: 5000 }, // newer copy
    { id: 'k', libraryId: 'libU', name: 'Kid A', artist: 'Radiohead', year: 2000, songCount: 10, addedAt: 9000 }
  ]
  const merged = M.mergeAlbums(a)
  const ok = merged.find((x) => M.norm(x.name).startsWith('ok computer'))
  assert.equal(ok.addedAt, 5000, 'the newer copy\'s addedAt wins')
  // Recently-added order (desc): Kid A (9000) before OK Computer (5000)
  assert.deepEqual(M.sortItems(merged, 'added', 'desc').map((x) => x.name), ['Kid A', 'OK Computer'])
})

test('mergeAlbums addedAt is null when no copy has one', () => {
  const merged = M.mergeAlbums([{ id: 'x', libraryId: 'libU', name: 'Solo', artist: 'Q', year: 0, songCount: 1 }])
  assert.equal(merged[0].addedAt, null)
})

test('sortItems sorts by any field, both directions, using normalized text', () => {
  const albums = [
    { name: 'Kid A', year: 2000 },
    { name: 'The Bends', year: 1995 },
    { name: 'Amnesiac', year: 2001 }
  ]
  assert.deepEqual(M.sortItems(albums, 'name', 'asc').map((a) => a.name), ['Amnesiac', 'The Bends', 'Kid A']) // "the" folded
  assert.deepEqual(M.sortItems(albums, 'year', 'desc').map((a) => a.year), [2001, 2000, 1995])
})

test('filterByLibrary narrows to a host, and _all/none returns everything', () => {
  const ix = M.buildIndex([umbrel, mac])
  const onlyMac = M.filterByLibrary(ix.albums, 'libM')
  assert.ok(onlyMac.every((a) => a.copies.some((c) => c.libraryId === 'libM')))
  // Kid A is only on Umbrel, so it's excluded from the Mac filter
  assert.ok(!onlyMac.some((a) => a.name === 'Kid A'))
  assert.equal(M.filterByLibrary(ix.albums, '_all').length, ix.albums.length)
  assert.equal(M.filterByLibrary(ix.albums, null).length, ix.albums.length)
})

test('bestCopy prefers a connected host, falls back in order, and defaults to primary', () => {
  const ix = M.buildIndex([umbrel, mac])
  const airbag = ix.tracks.find((t) => t.title === 'Airbag') // copies: [libM(primary), libU]
  assert.equal(M.bestCopy(airbag, new Set(['libM', 'libU'])).libraryId, 'libM', 'primary when online')
  assert.equal(M.bestCopy(airbag, new Set(['libU'])).libraryId, 'libU', 'fails over when primary offline')
  assert.equal(M.bestCopy(airbag, new Set()).libraryId, 'libM', 'none online -> primary (caller handles the error)')
  assert.equal(M.bestCopy(airbag).libraryId, 'libM', 'no connected set -> primary')
  assert.equal(M.bestCopy(null), null)
})
