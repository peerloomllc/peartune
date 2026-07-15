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
