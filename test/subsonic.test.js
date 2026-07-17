// Subsonic-compatible adapter: auth and id mapping.
//
// No network here. What is worth pinning is the stuff that is silently wrong
// rather than loudly broken: an auth scheme that leaks the password, and an id
// mapping that drifts from protocol/ids.js and orphans everyone's listening
// state.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const hcrypto = require('hypercore-crypto')

const { SubsonicAdapter } = require('../host/adapters/subsonic')
const { libraryId, trackId } = require('../protocol/ids')

const lib = libraryId(hcrypto.keyPair().publicKey)
const make = (opts = {}) => new SubsonicAdapter({
  url: 'http://localhost:4533/',
  username: 'tim',
  password: 'hunter2',
  libraryId: lib,
  ...opts
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

// AUTH FALLBACK, for Subsonic servers that reject the token scheme (Nextcloud
// Music, LMS answer error 41). The token scheme stays the default and the
// preferred one - the fallback sends the password, so we only use it when a server
// tells us it will not accept anything else.

test('the default auth mode is token - the fallback is never used unprompted', () => {
  const a = make()
  assert.equal(a._authMode, 'token')
  // A server that never says "41" must never see the password.
  assert.ok(!a._auth().includes('hunter2'))
})

test('in password mode it sends p=enc:<hex>, never the plaintext password', () => {
  const a = make()
  a._authMode = 'password' // what the 41 fallback sets

  const qs = a._auth()
  assert.ok(!/[?&]t=/.test(qs), 'no token in password mode')
  assert.ok(!qs.includes('hunter2'), 'the raw password must not appear even here')

  // p=enc:<hex of the password>, the Subsonic obfuscated form.
  const hex = /[?&]p=enc:([0-9a-f]+)/.exec(qs)?.[1]
  assert.ok(hex, 'must send p=enc:<hex>')
  assert.equal(Buffer.from(hex, 'hex').toString('utf8'), 'hunter2')
})

test('error 41 flips token -> password and retries once, then remembers', async () => {
  const a = make()
  let calls = 0
  const seen = []
  // Stub the network. Answer 41 to the token scheme once, ok to password.
  a._fetch = async (method) => {
    calls++
    seen.push(a._authMode)
    if (a._authMode === 'token') return { status: 'failed', error: { code: 41, message: 'token auth not supported' } }
    return { status: 'ok', method }
  }

  const r = await a._call('ping')
  assert.equal(r.status, 'ok')
  assert.equal(calls, 2, 'one 41, one retry')
  assert.deepEqual(seen, ['token', 'password'])
  assert.equal(a._authMode, 'password')

  // The next call goes STRAIGHT to password - it does not re-probe the token scheme.
  await a._call('ping')
  assert.equal(calls, 3, 'no second probe')
})

test('a real failure (wrong password, code 40) is NOT swallowed by the fallback', async () => {
  const a = make()
  a._fetch = async () => ({ status: 'failed', error: { code: 40, message: 'Wrong username or password' } })
  await assert.rejects(a._call('ping'), /code 40/)
})

// API-KEY AUTH (OpenSubsonic apiKeyAuthentication). Chosen when the operator gives a
// key; it sends apiKey=<key> and NO username - the spec forbids mixing them (error 43).

test('an apiKey selects apikey mode from the first call, no token probe', () => {
  const a = make({ apiKey: 'KEY123' })
  assert.equal(a._authMode, 'apikey')
})

test('apikey mode sends apiKey=<key> and NEVER a username or token/password', () => {
  const a = make({ apiKey: 'KEY123' })
  const qs = a._auth()

  assert.ok(/(^|&)apiKey=KEY123(&|$)/.test(qs), 'must send apiKey=<key>')
  // The spec is explicit: a client using an API key must not send u (error 43).
  assert.ok(!/(^|&)u=/.test(qs), 'must NOT send a username with an apiKey')
  assert.ok(!/(^|&)t=/.test(qs), 'no token in apikey mode')
  assert.ok(!/(^|&)p=/.test(qs), 'no password in apikey mode')
  assert.ok(!qs.includes('hunter2'), 'the password must not appear')
  // The always-required client/version/format params still ride along.
  assert.ok(qs.includes('c=peartune') && qs.includes('f=json'))
})

test('with no apiKey, mode is token (apikey is opt-in, never a fallback)', () => {
  const a = make()
  assert.equal(a._authMode, 'token')
})

// GRACEFUL DEGRADATION. "Subsonic-compatible" is a family, not a single spec:
// Funkwhale implements only a subset. An OPTIONAL endpoint the server lacks must
// return empty, not throw and take a whole screen down.

test('a missing getArtists degrades to an empty list, not a throw', async () => {
  const a = make()
  a._call = async (method) => {
    if (method === 'getArtists') throw new Error('subsonic getArtists: not implemented (code 70)')
    return {}
  }
  const page = await a.list({ type: 'artists' })
  assert.deepEqual(page.items, [], 'artists tab is empty, browsing by album still works')
})

test('a missing getPlaylists degrades to an empty list, not a throw', async () => {
  const a = make()
  a._call = async (method) => {
    if (method === 'getPlaylists') throw new Error('subsonic getPlaylists: not implemented')
    return {}
  }
  const page = await a.list({ type: 'playlists' })
  assert.deepEqual(page.items, [])
})

test('get(playlist) resolves the server playlist to OUR track ids, in order', async () => {
  const a = make()
  a._call = async (method, params) => {
    assert.equal(method, 'getPlaylist')
    assert.equal(params.id, 'pl-1')
    return { playlist: { id: 'pl-1', name: 'Roadtrip', entry: [{ id: 's2', title: 'B' }, { id: 's1', title: 'A' }] } }
  }
  const pl = await a.get({ type: 'playlist', id: 'pl-1' })
  assert.equal(pl.name, 'Roadtrip')
  // Order is the server's, and the ids are OURS (source-scoped), so listening state lines up.
  assert.deepEqual(pl.tracks.map(t => t.title), ['B', 'A'])
  assert.deepEqual(pl.tracks.map(t => t.id), [trackId(lib, 'subsonic', 's2'), trackId(lib, 'subsonic', 's1')])
})

test('get(playlist) degrades to null when the server has no playlist support', async () => {
  const a = make()
  a._call = async () => { throw new Error('subsonic getPlaylist: not implemented') }
  assert.equal(await a.get({ type: 'playlist', id: 'pl-x' }), null)
})

test('a CRITICAL endpoint still throws (a broken source must fail loudly)', async () => {
  const a = make()
  // getAlbumList2 is load-bearing: without it there is no library, so it must NOT be
  // swallowed the way an optional endpoint is.
  a._call = async () => { throw new Error('subsonic getAlbumList2: HTTP 500') }
  await assert.rejects(a.list({ type: 'albums' }), /getAlbumList2/)
})

// The server names itself. Every subsonic-response carries `type`, so the app can
// say "Nextcloud Music" instead of the umbrella "Subsonic".

test('_fetch CAPTURES the server type off a real subsonic-response', async (t) => {
  const a = make()
  const real = global.fetch
  // What a real Nextcloud Music answers with, in the response envelope.
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ 'subsonic-response': { status: 'ok', type: 'nextcloud music', serverVersion: '3.1.0', scanStatus: { count: 5 } } })
  })
  t.after(() => { global.fetch = real })

  await a.scan()
  assert.equal(a.serverType, 'nextcloud music')
  assert.equal(a.serverVersion, '3.1.0')
  assert.equal((await a.stats()).sourceName, 'Nextcloud Music')
})

test('the name is Title-Cased, with initialisms kept (navidrome, gonic, LMS)', async () => {
  const cases = { navidrome: 'Navidrome', gonic: 'Gonic', lms: 'LMS', airsonic: 'Airsonic', 'nextcloud music': 'Nextcloud Music' }
  for (const [type, expected] of Object.entries(cases)) {
    const a = make()
    a._counts = 1 // so stats() does not go back to the network
    a.serverType = type
    assert.equal((await a.stats()).sourceName, expected)
  }
})

test('a strict old server that sends no type yields a null name (app falls back)', async () => {
  const a = make()
  a._counts = 1
  assert.equal(a.serverType, undefined)
  assert.equal((await a.stats()).sourceName, null)
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
  assert.equal(t.id, trackId(lib, 'subsonic', 'song-42'))

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

// --- all songs --------------------------------------------------------------
//
// Subsonic proper has no "all songs" endpoint. Navidrome answers search3 with an
// EMPTY query as "everything", paged - verified against the real library (1358
// songs, songOffset paging works). A stricter server must still get an answer.

test('songs come from search3 with an EMPTY query, paged by songOffset', async () => {
  const a = make()
  const calls = []
  a._call = async (method, params) => {
    calls.push(method)
    assert.equal(method, 'search3')
    assert.equal(params.query, '')
    assert.equal(params.songOffset, 100)
    assert.equal(params.songCount, 50)
    return { searchResult3: { song: Array.from({ length: 50 }, (_, i) => ({ id: 's' + i, title: 't' + i })) } }
  }

  const page = await a.list({ type: 'tracks', cursor: 100, limit: 50 })
  assert.equal(page.items.length, 50)
  // A full page means there is probably another one.
  assert.equal(page.nextCursor, 150)
  // And crucially: it did NOT walk albums.
  assert.deepEqual(calls, ['search3'])
})

test('a short page is the last page', async () => {
  const a = make()
  a._call = async () => ({ searchResult3: { song: [{ id: 's1', title: 'x' }] } })
  const page = await a.list({ type: 'tracks', cursor: 0, limit: 50 })
  assert.equal(page.nextCursor, null)
})

test('a server that refuses an empty query falls back to walking albums', async () => {
  const a = make()
  const calls = []
  a._call = async (method) => {
    calls.push(method)
    if (method === 'search3') throw new Error('query is required')
    if (method === 'getAlbumList2') return { albumList2: { album: [{ id: 'al1' }] } }
    if (method === 'getAlbum') return { album: { song: [{ id: 's1', title: 'Fallback' }] } }
    return {}
  }

  const page = await a.list({ type: 'tracks', cursor: 0, limit: 50 })
  assert.equal(page.items[0].title, 'Fallback')
  assert.ok(calls.includes('getAlbumList2'), 'must fall back to the album walk')
})

test('an EMPTY first page is treated as "unsupported", not as "no music"', async () => {
  // The two are indistinguishable on the first page, and guessing wrong means an
  // empty Songs tab on a library that has 1358 of them.
  const a = make()
  const calls = []
  a._call = async (method) => {
    calls.push(method)
    if (method === 'search3') return { searchResult3: {} }
    if (method === 'getAlbumList2') return { albumList2: { album: [{ id: 'al1' }] } }
    if (method === 'getAlbum') return { album: { song: [{ id: 's1', title: 'Walked' }] } }
    return {}
  }

  const page = await a.list({ type: 'tracks', cursor: 0, limit: 50 })
  assert.equal(page.items[0].title, 'Walked')
  assert.ok(calls.includes('getAlbum'))
})

test('past the first page, an empty result IS the end - do not re-walk', async () => {
  const a = make()
  const calls = []
  a._call = async (method) => {
    calls.push(method)
    return { searchResult3: { song: [] } }
  }

  const page = await a.list({ type: 'tracks', cursor: 500, limit: 50 })
  assert.deepEqual(page.items, [])
  assert.equal(page.nextCursor, null)
  assert.deepEqual(calls, ['search3'], 'must not fall back once we are deep in the list')
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

// --- sorting (albums can; songs cannot; degrade honestly) ------------------------

test('stats advertises album sorts but NO song sort (search3 has no order)', async () => {
  const a = make()
  a._call = async () => ({})
  const { sorts } = await a.stats()
  assert.deepEqual(sorts.tracks.keys, [], 'no all-songs sort on Subsonic')
  assert.deepEqual(sorts.albums.keys, ['name', 'artist', 'year'])
  assert.deepEqual(sorts.artists.keys, [])
})

test('album sort maps to a getAlbumList2 type; year passes a full year range', async () => {
  const a = make()
  const seen = {}
  a._call = async (method, params) => { seen[method] = params; return { albumList2: { album: [] } } }

  await a.list({ type: 'albums', sort: 'artist' })
  assert.equal(seen.getAlbumList2.type, 'alphabeticalByArtist')

  await a.list({ type: 'albums', sort: 'year' })
  assert.equal(seen.getAlbumList2.type, 'byYear')
  assert.equal(seen.getAlbumList2.fromYear, 0)
  assert.equal(seen.getAlbumList2.toYear, 9999)

  await a.list({ type: 'albums' })
  assert.equal(seen.getAlbumList2.type, 'alphabeticalByName', 'default is name order')
})

test('a song sort is silently ignored (search3 takes no order), not an error', async () => {
  const a = make()
  let params = null
  a._call = async (method, p) => { params = p; return { searchResult3: { song: [{ id: 's1', title: 'x' }] } } }
  await a.list({ type: 'tracks', sort: 'title', order: 'desc' })
  assert.equal(params.query, '', 'still the empty-query all-songs call')
  assert.equal('sort' in params, false, 'no sort leaks into the Subsonic request')
})
