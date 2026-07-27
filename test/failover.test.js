// Mid-song failover: which copy do we continue from, and may we splice into it?
//
// Tim, 2026-07-26: if two libraries hold the same song and one revokes you mid-song, the music
// should carry on from the other. proposals/2026-07-27-mid-song-failover.md. The dangerous half is
// `identical`: splicing continues ONE http response with bytes from a different host, so getting
// it wrong turns a revoke into noise coming out of the speaker.

const test = require('node:test')
const assert = require('node:assert/strict')

const { pickAltCopy, sameBytes } = require('../worklet/failover')

const FLAC = { libraryId: 'lib-a', id: 'a1', size: 4657826, suffix: 'flac' }
const FLAC_MIRROR = { libraryId: 'lib-b', id: 'b1', size: 4657826, suffix: 'flac' }
const MP3 = { libraryId: 'lib-c', id: 'c1', size: 3197588, suffix: 'mp3' }

const track = (...copies) => ({ copies })

test('a byte-identical copy on a reachable library is spliceable', () => {
  const alt = pickAltCopy({
    track: track(FLAC, FLAC_MIRROR),
    failedLibraryId: 'lib-a',
    connected: new Set(['lib-b']),
    currentId: 'a1'
  })
  assert.deepEqual(alt, { libraryId: 'lib-b', id: 'b1', identical: true })
})

test('a DIFFERENT encode is offered but never marked spliceable', () => {
  // The merge prefers a lossless primary, so FLAC-here / MP3-there is the normal case across
  // hosts. Splicing those mid-stream is noise; the caller must re-open the track instead.
  const alt = pickAltCopy({
    track: track(FLAC, MP3),
    failedLibraryId: 'lib-a',
    connected: new Set(['lib-c']),
    currentId: 'a1'
  })
  assert.deepEqual(alt, { libraryId: 'lib-c', id: 'c1', identical: false })
})

test('the library that just failed is never the answer', () => {
  const alt = pickAltCopy({
    track: track(FLAC, FLAC_MIRROR),
    failedLibraryId: 'lib-b',
    connected: new Set(['lib-a', 'lib-b']),
    currentId: 'b1'
  })
  assert.equal(alt.libraryId, 'lib-a')
})

test('an unreachable copy is not offered - including a revoked one', () => {
  // connectedLibs() is LIVE link state, so a revoked library has already left it. This is what
  // stops a revoke being answered by dialling straight back into the library that revoked us.
  const alt = pickAltCopy({
    track: track(FLAC, FLAC_MIRROR),
    failedLibraryId: 'lib-a',
    connected: new Set(),
    currentId: 'a1'
  })
  assert.equal(alt, null)
})

test('a track only one library has has no fallback', () => {
  const alt = pickAltCopy({
    track: track(FLAC),
    failedLibraryId: 'lib-a',
    connected: new Set(['lib-b']),
    currentId: 'a1'
  })
  assert.equal(alt, null)
})

test('identity is judged against the copy we were PLAYING, not the primary', () => {
  // Playing the MP3 on lib-c: the FLAC on lib-a is not a splice target even though it is the
  // primary and both are "the same song".
  const alt = pickAltCopy({
    track: track(FLAC, MP3),
    failedLibraryId: 'lib-c',
    connected: new Set(['lib-a']),
    currentId: 'c1'
  })
  assert.deepEqual(alt, { libraryId: 'lib-a', id: 'a1', identical: false })
})

test('a missing size never reads as identical', () => {
  // Some adapters omit size. Unknown must mean "do not splice", never "assume it lines up".
  assert.equal(sameBytes({ size: 0, suffix: 'flac' }, { size: 0, suffix: 'flac' }), false)
  assert.equal(sameBytes({ suffix: 'flac' }, { size: 100, suffix: 'flac' }), false)
})

test('same size, different container is not identical', () => {
  assert.equal(sameBytes({ size: 100, suffix: 'flac' }, { size: 100, suffix: 'mp3' }), false)
  assert.equal(sameBytes({ size: 100, suffix: 'flac' }, { size: 100, suffix: 'flac' }), true)
})

test('junk copies are skipped rather than thrown on', () => {
  const alt = pickAltCopy({
    track: { copies: [null, {}, { libraryId: 'lib-b' }, FLAC_MIRROR] },
    failedLibraryId: 'lib-a',
    connected: new Set(['lib-b']),
    currentId: 'a1'
  })
  assert.equal(alt.id, 'b1')
})

test('no track, no copies, no crash', () => {
  assert.equal(pickAltCopy({ track: null, failedLibraryId: 'x', connected: new Set(), currentId: 'y' }), null)
  assert.equal(pickAltCopy({ track: {}, failedLibraryId: 'x', connected: new Set(), currentId: 'y' }), null)
})
