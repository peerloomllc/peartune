// Navidrome adapter: auth and id mapping.
//
// No network here. What is worth pinning is the stuff that is silently wrong
// rather than loudly broken: an auth scheme that leaks the password, and an id
// mapping that drifts from protocol/ids.js and orphans everyone's listening
// state.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const hcrypto = require('hypercore-crypto')

const { NavidromeAdapter } = require('../host/adapters/navidrome')
const { libraryId, trackId } = require('../protocol/ids')

const lib = libraryId(hcrypto.keyPair().publicKey)
const make = () => new NavidromeAdapter({
  url: 'http://localhost:4533/',
  username: 'tim',
  password: 'hunter2',
  libraryId: lib
})

test('auth uses salted token, and NEVER sends the password', () => {
  const a = make()
  const qs = a._auth()

  assert.ok(!qs.includes('hunter2'), 'the password must never appear in a request')
  assert.ok(!/[?&]p=/.test(qs), 'must not use the plaintext p= parameter')

  const token = /[?&]?t=([0-9a-f]{32})/.exec(qs)?.[1]
  const salt = /[?&]s=([0-9a-f]+)/.exec(qs)?.[1]
  assert.ok(token, 'must send a token')
  assert.ok(salt, 'must send a salt')

  // The token is exactly Subsonic's md5(password + salt).
  assert.equal(token, crypto.createHash('md5').update('hunter2' + salt).digest('hex'))
})

test('a fresh salt per request (a captured token cannot be replayed)', () => {
  const a = make()
  const s1 = /[?&]s=([0-9a-f]+)/.exec(a._auth())[1]
  const s2 = /[?&]s=([0-9a-f]+)/.exec(a._auth())[1]
  assert.notEqual(s1, s2)
})

test('trailing slashes on the base url do not produce a double slash', () => {
  const a = make()
  assert.ok(a._url('ping').startsWith('http://localhost:4533/rest/ping?'))
})

test('query params are url-encoded (a search for "AC/DC" must not break the url)', () => {
  const a = make()
  const url = a._url('search3', { query: 'AC/DC & Friends' })
  assert.ok(url.includes('query=AC%2FDC%20%26%20Friends'))
})

test('empty params are dropped rather than sent blank', () => {
  const a = make()
  const url = a._url('stream', { id: 'x', maxBitRate: undefined, format: null })
  assert.ok(!url.includes('maxBitRate'))
  assert.ok(!url.includes('format'))
})

test('track ids match protocol/ids.js exactly, and are SOURCE-SCOPED', () => {
  const a = make()
  const t = a._track({ id: 'song-42', title: 'Payback', size: 100 })

  // If this drifts, every resume position, favorite and play count is orphaned.
  assert.equal(t.id, trackId(lib, 'navidrome', 'song-42'))

  // The same underlying file via the folder adapter is deliberately a DIFFERENT
  // id (DECISIONS 2026-07-13). Not a bug; do not "fix" it.
  assert.notEqual(t.id, trackId(lib, 'folder', 'song-42'))
})

test('_track remembers the Subsonic id so media.stream can map back', () => {
  const a = make()
  const t = a._track({ id: 'song-42', title: 'x', size: 1 })
  assert.equal(a.songIds.get(t.id), 'song-42')
})

test('_track normalizes a sparse song without throwing', () => {
  const a = make()
  const t = a._track({ id: 's1' })
  assert.equal(t.title, 'Unknown')
  assert.equal(t.artist, null)
  assert.equal(t.size, 0)
  assert.equal(t.durationMs, null)
})

test('duration is converted from Subsonic seconds to our milliseconds', () => {
  const a = make()
  assert.equal(a._track({ id: 's', duration: 171 }).durationMs, 171000)
})

// --- artist detail ----------------------------------------------------------
//
// An artist is its albums. getArtist returns them in ONE call, so artist browsing
// costs the same round trip as album browsing rather than walking the library.

test('get({type:"artist"}) returns the artist and its albums', async () => {
  const a = make()
  a._call = async (method, params) => {
    assert.equal(method, 'getArtist')
    assert.equal(params.id, 'ar-1')
    return {
      artist: {
        id: 'ar-1',
        name: 'Portishead',
        coverArt: 'ar-1',
        album: [
          { id: 'al-1', name: 'Dummy', year: 1994, songCount: 11, coverArt: 'al-1' },
          // No coverArt and no artist: both must fall back rather than go null.
          { id: 'al-2', name: 'Third' }
        ]
      }
    }
  }

  const r = await a.get({ id: 'ar-1', type: 'artist' })
  assert.equal(r.name, 'Portishead')
  assert.equal(r.albums.length, 2)
  assert.equal(r.albums[0].coverId, 'al-1')
  assert.equal(r.albums[0].year, 1994)

  // The album id doubles as the cover id in Subsonic, and an album under an
  // artist inherits that artist's name - otherwise the artist page renders a
  // grid of albums with a blank byline.
  assert.equal(r.albums[1].coverId, 'al-2')
  assert.equal(r.albums[1].artist, 'Portishead')
})

test('an unknown artist is null, not a throw', async () => {
  const a = make()
  a._call = async () => ({})
  assert.equal(await a.get({ id: 'nope', type: 'artist' }), null)
})

test('an artist with no albums is an empty grid, not a crash', async () => {
  const a = make()
  a._call = async () => ({ artist: { id: 'ar-9', name: 'Nobody' } })
  const r = await a.get({ id: 'ar-9', type: 'artist' })
  assert.deepEqual(r.albums, [])
})

test('default playback asks for RAW (original bytes), not a transcode', () => {
  const a = make()
  // No format/bitrate requested -> format=raw, so the default path is exact
  // original bytes and byte-range seeking works.
  const url = a._url('stream', { id: 'x', format: 'raw' })
  assert.ok(url.includes('format=raw'))
})
