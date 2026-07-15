// Jellyfin / Emby adapter: auth headers, id mapping, labelling.
//
// No network. The load-bearing thing to pin is the AUTH SHIM: one adapter serves both
// Jellyfin and Emby by sending both header flavors, and if that drifts an Emby box
// silently 401s on every call. Also the id mapping (drift orphans listening state) and
// the ProductName-driven label.

const test = require('node:test')
const assert = require('node:assert/strict')
const hcrypto = require('hypercore-crypto')

const { JellyfinAdapter } = require('../host/adapters/jellyfin')
const { libraryId, trackId } = require('../protocol/ids')

const lib = libraryId(hcrypto.keyPair().publicKey)
const make = (opts = {}) => new JellyfinAdapter({
  url: 'http://localhost:8096/',
  username: 'tim',
  password: 'hunter2',
  libraryId: lib,
  ...opts
})

// --- the Emby shim: BOTH auth flavors on every request ----------------------

test('unauthenticated: sends the identity in BOTH Authorization and X-Emby-Authorization', () => {
  const a = make()
  const h = a._authHeaders()

  // Jellyfin reads this.
  assert.ok(h.authorization.startsWith('MediaBrowser '), 'Jellyfin Authorization header')
  assert.ok(h.authorization.includes('Client="PearTune"'))
  assert.ok(h.authorization.includes('DeviceId="' + a.deviceId + '"'))

  // Emby reads this.
  assert.ok(h['x-emby-authorization'].startsWith('MediaBrowser '), 'Emby X-Emby-Authorization header')
  assert.ok(h['x-emby-authorization'].includes('Client="PearTune"'))

  // No token yet: neither carries one.
  assert.ok(!h.authorization.includes('Token='), 'no token before login')
  assert.equal(h['x-emby-token'], undefined, 'no X-Emby-Token before login')
})

test('authenticated: token rides in Authorization (Jellyfin) AND X-Emby-Token (Emby)', () => {
  const a = make()
  a.token = 'TOKEN123' // what _auth() sets after AuthenticateByName

  const h = a._authHeaders()
  // Jellyfin: token embedded in the Authorization header.
  assert.ok(h.authorization.includes('Token="TOKEN123"'), 'Jellyfin token in Authorization')
  // Emby: token in its own header.
  assert.equal(h['x-emby-token'], 'TOKEN123', 'Emby token in X-Emby-Token')
  // Emby's X-Emby-Authorization stays identity-only (Emby does NOT read a token there).
  assert.ok(!h['x-emby-authorization'].includes('Token='), 'X-Emby-Authorization is identity only')
})

test('the deviceId is stable (derived from the library, not random)', () => {
  assert.equal(make().deviceId, make().deviceId, 'two adapters on one library share a deviceId')
  assert.ok(make().deviceId.startsWith('peartune-'))
})

// --- labelling: the server names itself -------------------------------------

test('_nameFromInfo: Jellyfin advertises ProductName, Emby does not (so no-ProductName = Emby)', () => {
  const a = make()
  // Jellyfin's /System/Info/Public.
  assert.equal(a._nameFromInfo({ ProductName: 'Jellyfin Server', Version: '10.11' }), 'Jellyfin Server')
  // Emby's - measured on a real 4.9 box: ServerName + Version, NO ProductName.
  assert.equal(a._nameFromInfo({ ServerName: 'a30c7575530d', Version: '4.9.5.0' }), 'Emby')
  // Unreachable: null, and stats() then falls back to the kind's primary label.
  assert.equal(a._nameFromInfo(null), null)
})

test('sourceName is the server\'s OWN name, with a Jellyfin fallback when unknown', async () => {
  const unknown = make()
  assert.equal((await unknown.stats()).sourceName, 'Jellyfin', 'fallback when we have not scanned')

  const emby = make()
  emby._serverName = 'Emby'
  assert.equal((await emby.stats()).sourceName, 'Emby')
})

// --- id mapping -------------------------------------------------------------

test('track ids match protocol/ids.js and are SOURCE-SCOPED to jellyfin', () => {
  const a = make()
  const t = a._track({ Id: 'item-42', Name: 'Payback', MediaSources: [{ Size: 100, Container: 'flac' }] })

  assert.equal(t.id, trackId(lib, 'jellyfin', 'item-42'))
  // A different family than a Subsonic or folder track for the same key.
  assert.notEqual(t.id, trackId(lib, 'subsonic', 'item-42'))
  // _track remembers the Jellyfin/Emby item id so stream() can map back.
  assert.equal(a.itemIds.get(t.id), 'item-42')
})

test('_track converts RunTimeTicks (100ns) to ms and reads size from MediaSources', () => {
  const a = make()
  const t = a._track({ Id: 'i', Name: 'x', RunTimeTicks: 1800000000, MediaSources: [{ Size: 4096 }] })
  assert.equal(t.durationMs, 180000, '1.8e9 ticks / 10000 = 180000 ms')
  assert.equal(t.size, 4096)
})

test('a sparse item normalizes without throwing', () => {
  const a = make()
  const t = a._track({ Id: 'i' })
  assert.equal(t.title, 'Unknown')
  assert.equal(t.size, 0)
  assert.equal(t.durationMs, null)
})

// --- playlists (v2: read the server's own, resolved to our track ids) --------

test('get(playlist) returns the ordered tracks with OUR ids', async () => {
  const a = make()
  a.userId = 'u1'
  a._call = async (path) => {
    if (path === '/Users/u1/Items/pl-1') return { Name: 'Roadtrip' }
    if (path === '/Playlists/pl-1/Items') return { Items: [{ Id: 'i2', Name: 'B' }, { Id: 'i1', Name: 'A' }] }
    return null
  }
  const pl = await a.get({ type: 'playlist', id: 'pl-1' })
  assert.equal(pl.name, 'Roadtrip')
  // Playlist order is the server's; the ids are ours (source-scoped).
  assert.deepEqual(pl.tracks.map(t => t.title), ['B', 'A'])
  assert.deepEqual(pl.tracks.map(t => t.id), [trackId(lib, 'jellyfin', 'i2'), trackId(lib, 'jellyfin', 'i1')])
})

test('get(playlist) is null when neither the playlist nor its items resolve', async () => {
  const a = make()
  a.userId = 'u1'
  a._call = async () => { throw new Error('Jellyfin: 404') }
  assert.equal(await a.get({ type: 'playlist', id: 'gone' }), null)
})
