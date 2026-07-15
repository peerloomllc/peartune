// User state (host-as-hub favorites) + owner derivation.
//
// The security property is that the OWNER is derived by the host from the
// authenticated connection, never sent by the client - so the two things worth pinning
// are: the store keeps owners isolated, and ownerOf maps a grant to a stable owner such
// that a person's devices SHARE state while strangers do not.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')

const { UserState } = require('../host/state')
const { ownerOf } = require('../host/media')

async function store (t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-state-'))
  const cs = new Corestore(dir)
  const bee = new Hyperbee(cs.get({ name: 's' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.ready()
  t.after(async () => {
    await bee.close()
    await cs.close()
    await fsp.rm(dir, { recursive: true, force: true })
  })
  return { bee, dir, cs }
}

// --- ownerOf: how a connection maps to an owner ------------------------------

test('ownerOf uses the person when assigned, else the device key', () => {
  assert.equal(ownerOf({ deviceKey: 'DEV', personId: 'PER' }), 'p:PER')
  assert.equal(ownerOf({ deviceKey: 'DEV', personId: null }), 'd:DEV')
})

test("a person's two devices share an owner; a stranger does not", () => {
  const tabletOfTim = { deviceKey: 'TABLET', personId: 'TIM' }
  const phoneOfTim = { deviceKey: 'PHONE', personId: 'TIM' }
  const asasPhone = { deviceKey: 'ASA', personId: 'ASA' }
  const unclaimed = { deviceKey: 'PHONE', personId: null }

  // Phone + tablet of one person => same owner => they share favorites via the host.
  assert.equal(ownerOf(tabletOfTim), ownerOf(phoneOfTim))
  // A different person is a different owner.
  assert.notEqual(ownerOf(phoneOfTim), ownerOf(asasPhone))
  // An unclaimed device is its OWN owner - even the same physical key differs from the
  // person owner, which is why assigning-then-reconnecting moves your favorites.
  assert.notEqual(ownerOf(phoneOfTim), ownerOf(unclaimed))
})

// --- the store ---------------------------------------------------------------

test('a favorite is set and listed back for its owner, grouped by kind', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)

  assert.deepEqual(await s.listFavs('p:tim'), { track: [], album: [], artist: [] })
  const row = await s.setFav('p:tim', 'track', 'track-1', true)
  assert.equal(row.on, true)
  assert.ok(row.updatedAt, 'the host stamps updatedAt')
  assert.deepEqual(await s.listFavs('p:tim'), { track: ['track-1'], album: [], artist: [] })
})

test('favorites are grouped by KIND: track / album / artist are independent buckets', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)

  await s.setFav('p:tim', 'track', 't1', true)
  await s.setFav('p:tim', 'album', 'al1', true)
  await s.setFav('p:tim', 'artist', 'ar1', true)
  // Same id string under two kinds must not collide.
  await s.setFav('p:tim', 'album', 'shared', true)
  await s.setFav('p:tim', 'artist', 'shared', true)

  assert.deepEqual(await s.listFavs('p:tim'), {
    track: ['t1'], album: ['al1', 'shared'], artist: ['ar1', 'shared']
  })
})

test('an unknown kind is rejected, not stored', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)
  await assert.rejects(() => s.setFav('p:tim', 'playlist', 'x', true), /bad favorite kind/)
})

test('un-favoriting is durable: the row stays off, not resurrected', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)

  await s.setFav('p:tim', 'album', 'al1', true)
  await s.setFav('p:tim', 'album', 'al1', false)
  assert.deepEqual((await s.listFavs('p:tim')).album, [], 'off is off')
  assert.equal((await s.getFav('p:tim', 'album', 'al1')).on, false)
})

test('owners are ISOLATED: one owner never sees another owner\'s favorites', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)

  await s.setFav('p:tim', 'track', 'track-1', true)
  await s.setFav('d:asasphone', 'track', 'track-2', true)

  assert.deepEqual((await s.listFavs('p:tim')).track, ['track-1'])
  assert.deepEqual((await s.listFavs('d:asasphone')).track, ['track-2'])
})

test('one owner-prefix is not a prefix of another (range scan is exact)', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)

  // 'p:tim' must not leak into a scan for 'p:ti' or vice versa.
  await s.setFav('p:tim', 'track', 'a', true)
  await s.setFav('p:ti', 'track', 'b', true)
  assert.deepEqual((await s.listFavs('p:tim')).track, ['a'])
  assert.deepEqual((await s.listFavs('p:ti')).track, ['b'])
})

// --- play counts -------------------------------------------------------------

test('bumpCount increments per play and reads back', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)
  assert.equal(await s.getCount('p:tim', 't1'), 0)
  assert.equal(await s.bumpCount('p:tim', 't1'), 1)
  assert.equal(await s.bumpCount('p:tim', 't1'), 2)
  assert.equal(await s.getCount('p:tim', 't1'), 2)
})

test('topCounts returns most-played first, per owner', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)
  await s.bumpCount('p:tim', 'a')
  await s.bumpCount('p:tim', 'b'); await s.bumpCount('p:tim', 'b'); await s.bumpCount('p:tim', 'b')
  await s.bumpCount('p:tim', 'c'); await s.bumpCount('p:tim', 'c')
  await s.bumpCount('d:asas', 'z') // another owner, must not appear

  const top = await s.topCounts('p:tim', 2)
  assert.deepEqual(top, [{ trackId: 'b', count: 3 }, { trackId: 'c', count: 2 }])
  assert.deepEqual(await s.topCounts('d:asas'), [{ trackId: 'z', count: 1 }])
})

// --- resume positions --------------------------------------------------------

test('a resume position is set and read back for its owner', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)

  assert.deepEqual(await s.getResume('p:tim', 't1'), null, 'nothing yet')
  const row = await s.setResume('p:tim', 't1', 90000, 240000)
  assert.equal(row.positionMs, 90000)
  assert.equal(row.durationMs, 240000)
  assert.ok(row.updatedAt)
  assert.equal((await s.getResume('p:tim', 't1')).positionMs, 90000)
})

test('a position of 0 (or finishing) DELETES the row - the track starts fresh', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)

  await s.setResume('p:tim', 't1', 90000, 240000)
  assert.equal(await s.setResume('p:tim', 't1', 0, 240000), null, 'zero is a clear')
  assert.equal(await s.getResume('p:tim', 't1'), null, 'the row is gone, not a stored 0')
})

test('resume positions are per-owner isolated', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)
  await s.setResume('p:tim', 't1', 5000, 100000)
  assert.equal(await s.getResume('d:asas', 't1'), null, 'another owner has no resume for it')
})

test('latestResume returns the MOST RECENTLY updated resume (the continue candidate)', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)
  assert.equal(await s.latestResume('p:tim'), null, 'nothing to continue yet')

  await s.setResume('p:tim', 't1', 10000, 200000)
  await new Promise(r => setTimeout(r, 5)) // ensure a later updatedAt
  await s.setResume('p:tim', 't2', 20000, 300000)

  const latest = await s.latestResume('p:tim')
  assert.equal(latest.trackId, 't2', 'the one touched last')
  assert.equal(latest.positionMs, 20000)

  // Finishing t2 (clear) makes t1 the candidate again.
  await s.setResume('p:tim', 't2', 0)
  assert.equal((await s.latestResume('p:tim')).trackId, 't1')
})

test('favorites persist across a store reopen (they are on disk, not in memory)', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-state-persist-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const cs1 = new Corestore(dir)
  const bee1 = new Hyperbee(cs1.get({ name: 's' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee1.ready()
  await new UserState(bee1).setFav('p:tim', 'artist', 'ar1', true)
  await bee1.close()
  await cs1.close()

  // Reopen the same corestore from disk.
  const cs2 = new Corestore(dir)
  const bee2 = new Hyperbee(cs2.get({ name: 's' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee2.ready()
  t.after(async () => { await bee2.close(); await cs2.close() })

  assert.deepEqual((await new UserState(bee2).listFavs('p:tim')).artist, ['ar1'])
})

// --- playlists (milestone 3, phase 4) ----------------------------------------

test('a playlist is created with a host-minted id and an empty ordered list', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)

  const pl = await s.createPlaylist('p:tim', 'Roadtrip')
  assert.ok(pl.id, 'the host mints the id, the client does not')
  assert.equal(pl.name, 'Roadtrip')
  assert.deepEqual(pl.trackIds, [])
  assert.ok(pl.createdAt && pl.updatedAt)

  const back = await s.getPlaylist('p:tim', pl.id)
  assert.deepEqual(back.trackIds, [])
  assert.deepEqual((await s.listPlaylists('p:tim')).map(p => [p.name, p.count]), [['Roadtrip', 0]])
})

test('adding appends (dupes allowed); setTracks replaces the whole order', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)
  const pl = await s.createPlaylist('p:tim', 'Mix')

  await s.addToPlaylist('p:tim', pl.id, ['a', 'b'])
  await s.addToPlaylist('p:tim', pl.id, ['b', 'c']) // 'b' again is intentional
  assert.deepEqual((await s.getPlaylist('p:tim', pl.id)).trackIds, ['a', 'b', 'b', 'c'])

  // Reorder-and-remove is one write: send the new order (drop a dupe, flip the ends).
  await s.setPlaylistTracks('p:tim', pl.id, ['c', 'b', 'a'])
  assert.deepEqual((await s.getPlaylist('p:tim', pl.id)).trackIds, ['c', 'b', 'a'])
})

test('rename changes the name; delete removes the playlist', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)
  const pl = await s.createPlaylist('p:tim', 'old')

  const renamed = await s.renamePlaylist('p:tim', pl.id, 'new')
  assert.equal(renamed.name, 'new')
  assert.equal((await s.getPlaylist('p:tim', pl.id)).name, 'new')

  await s.deletePlaylist('p:tim', pl.id)
  assert.equal(await s.getPlaylist('p:tim', pl.id), null)
  assert.deepEqual(await s.listPlaylists('p:tim'), [])
})

test('a mutation on a playlist the owner does not have returns null (the ownership check)', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)
  const mine = await s.createPlaylist('p:tim', 'mine')

  // Asa cannot touch Tim's playlist even knowing its id: the key carries the owner.
  assert.equal(await s.getPlaylist('p:asa', mine.id), null)
  assert.equal(await s.addToPlaylist('p:asa', mine.id, ['x']), null)
  assert.equal(await s.renamePlaylist('p:asa', mine.id, 'hijack'), null)
  assert.equal(await s.setPlaylistTracks('p:asa', mine.id, ['x']), null)
  // Tim's playlist is untouched.
  assert.deepEqual((await s.getPlaylist('p:tim', mine.id)).trackIds, [])
  assert.deepEqual(await s.listPlaylists('p:asa'), [])
})

test('playlists are owner-isolated in the list scan', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)
  await s.createPlaylist('p:tim', 'tim-one')
  await s.createPlaylist('p:asa', 'asa-one')
  assert.deepEqual((await s.listPlaylists('p:tim')).map(p => p.name), ['tim-one'])
  assert.deepEqual((await s.listPlaylists('p:asa')).map(p => p.name), ['asa-one'])
})

test('a playlist name is sanitized: control chars stripped, empty becomes a default, length capped', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)

  const ctrl = await s.createPlaylist('p:tim', '  road\x00trip\t ')
  assert.equal(ctrl.name, 'roadtrip', 'the NUL and tab (control chars) are stripped and the ends trimmed')

  const blank = await s.createPlaylist('p:tim', '   ')
  assert.equal(blank.name, 'Untitled playlist', 'an empty name is a sensible default, not a blank row')

  const long = await s.createPlaylist('p:tim', 'x'.repeat(500))
  assert.equal(long.name.length, 100, 'name capped')
})

test('trackIds are validated: non-strings are dropped, not stored', async (t) => {
  const { bee } = await store(t)
  const s = new UserState(bee)
  const pl = await s.createPlaylist('p:tim', 'Mix')
  await s.addToPlaylist('p:tim', pl.id, ['a', 123, null, '', 'b', undefined])
  assert.deepEqual((await s.getPlaylist('p:tim', pl.id)).trackIds, ['a', 'b'])
})
