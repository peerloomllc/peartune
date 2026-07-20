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
