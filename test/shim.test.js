// The shim's pure URL router (multi-host step 2, slice 4). Both the single-host form (/t/<id>,
// /art/<id>) and the merged form that carries the owning host (/t/<lib>/<id>, /art/<lib>/<id>) must
// parse unambiguously - a mis-parse would stream from the wrong server or 404 a valid track. Only
// parseUrl is pure (the server itself needs bare-http1 + a live socket); it's the routing decision,
// so it's the bit worth pinning.

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseUrl, DEFAULT_ART_SIZE } = require('../worklet/shim')

test('single-host track URL parses with no libraryId', () => {
  assert.deepEqual(parseUrl('/t/abc123def'), { kind: 'track', libraryId: null, id: 'abc123def' })
})

test('merged track URL carries the owning host', () => {
  assert.deepEqual(parseUrl('/t/lib9xyz/track7abc'), { kind: 'track', libraryId: 'lib9xyz', id: 'track7abc' })
})

test('single-host art URL parses with no libraryId and the default size', () => {
  assert.deepEqual(parseUrl('/art/cover1'), { kind: 'art', libraryId: null, id: 'cover1', size: DEFAULT_ART_SIZE })
})

test('merged art URL carries the owning host', () => {
  const r = parseUrl('/art/lib9xyz/cover1')
  assert.equal(r.kind, 'art')
  assert.equal(r.libraryId, 'lib9xyz')
  assert.equal(r.id, 'cover1')
})

test('art size rides the query string and caps at the max', () => {
  assert.equal(parseUrl('/art/cover1?s=500').size, 500)
  assert.equal(parseUrl('/art/lib9/cover1?s=500').size, 500)
  assert.equal(parseUrl('/art/cover1?s=99999').size, 1200, 'capped at MAX_ART_SIZE')
  assert.equal(parseUrl('/art/cover1').size, DEFAULT_ART_SIZE, 'no ?s -> default')
})

test('a server coverId with punctuation stays intact (permissive tail), single and merged', () => {
  assert.equal(parseUrl('/art/al-1234').id, 'al-1234')
  assert.equal(parseUrl('/art/al-1234').libraryId, null)
  const m = parseUrl('/art/lib9xyz/mf-99-abc')
  assert.equal(m.libraryId, 'lib9xyz')
  assert.equal(m.id, 'mf-99-abc')
})

test('an encoded coverId is decoded', () => {
  assert.equal(parseUrl('/art/a%20b').id, 'a b')
  assert.equal(parseUrl('/art/lib9/a%20b').id, 'a b')
})

test('a track path is never mistaken for art and vice-versa', () => {
  assert.equal(parseUrl('/t/abc').kind, 'track')
  assert.equal(parseUrl('/art/abc').kind, 'art')
})

test('unknown paths return null', () => {
  assert.equal(parseUrl('/'), null)
  assert.equal(parseUrl('/nope/abc'), null)
  assert.equal(parseUrl(''), null)
})

// --- the artwork generation segment -----------------------------------------
//
// `/art/_g<N>/` is a cache-buster minted by "Refresh artwork", and it exists because clearing the
// cover store did nothing you could see: the WebView answers a cover it has already rendered from
// its OWN http cache (the shim serves art with max-age=86400), so the request never reaches the
// shim and nothing re-fetches. A URL the WebView has never seen is the only thing that misses.
//
// It carries NO routing meaning, so what these pin is that it is invisible to the router - and,
// most importantly, that it can never be mistaken for the merged form's library segment.

test('a generation segment routes exactly like no segment', () => {
  assert.deepEqual(parseUrl('/art/_g1/cover42'), parseUrl('/art/cover42'))
  assert.deepEqual(parseUrl('/art/_g27/cover42?s=500'), parseUrl('/art/cover42?s=500'))
})

test('a generation segment does NOT become a libraryId', () => {
  // The real hazard: /art/<libraryId>/<coverId> is the merged form, so a generation segment that
  // matched it would route every cover to a library that does not exist. The leading underscore
  // is what prevents it - z32 has no '_'.
  const r = parseUrl('/art/_g3/cover42')
  assert.equal(r.libraryId, null)
  assert.equal(r.id, 'cover42')
})

test('a generation rides in FRONT of a real libraryId, and both survive', () => {
  const r = parseUrl('/art/abc123/cover42?s=350')
  assert.equal(r.libraryId, 'abc123')
  const g = parseUrl('/art/_g2/abc123/cover42?s=350')
  assert.deepEqual(g, r)
})

test('the size still parses through a generation segment', () => {
  assert.equal(parseUrl('/art/_g9/cover42?s=1200').size, 1200)
  assert.equal(parseUrl('/art/_g9/cover42').size, DEFAULT_ART_SIZE)
})

test('a cover legitimately named like a generation is not eaten', () => {
  // Only a LEADING /art/_g<digits>/ is a generation. A cover id that merely looks like one, or a
  // generation-shaped segment with no trailing path, must be left alone.
  assert.equal(parseUrl('/art/_g5').id, '_g5')
  assert.equal(parseUrl('/art/_gabc/cover42').libraryId, null)
  assert.equal(parseUrl('/art/_gabc/cover42').id, '_gabc/cover42'.split('/')[0])
})

test('track URLs are untouched by any of this', () => {
  assert.deepEqual(parseUrl('/t/abc123'), { kind: 'track', libraryId: null, id: 'abc123' })
  assert.equal(parseUrl('/t/_g1/abc123'), null) // not a real form, and must not silently route
})
