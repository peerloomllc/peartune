// Music requests (proposal 2026-07-24-owner-in-the-app, P1).
//
// The host is the single writer and the requester is host-derived, so the things worth
// pinning are the store's own rules: dedup folds an identical PENDING ask (and only a
// pending one), a requester sees only their own, resolve is one-way and stamps time, and
// person-deletion takes their requests with it.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')

const { UserState } = require('../host/state')

async function newState (t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-req-'))
  const cs = new Corestore(dir)
  const bee = new Hyperbee(cs.get({ name: 's' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.ready()
  t.after(async () => { await bee.close(); await cs.close(); await fsp.rm(dir, { recursive: true, force: true }) })
  return new UserState(bee)
}

test('a request is filed with the host-stamped shape', async (t) => {
  const s = await newState(t)
  const r = await s.addRequest('p:alice', { kind: 'album', name: 'Blue', artist: 'Joni Mitchell' })
  assert.equal(r.kind, 'album')
  assert.equal(r.name, 'Blue')
  assert.equal(r.artist, 'Joni Mitchell')
  assert.equal(r.requester, 'p:alice')
  assert.equal(r.status, 'pending')
  assert.equal(r.count, 1)
  assert.ok(r.id && r.createdAt)
})

test('an identical pending request FOLDS (count bumps, no duplicate row)', async (t) => {
  const s = await newState(t)
  const a = await s.addRequest('p:alice', { kind: 'album', name: 'Blue', artist: 'Joni Mitchell' })
  // Same ask, punctuation/case/accents differ - must fold to the same request.
  const b = await s.addRequest('p:bob', { kind: 'album', name: 'blue', artist: 'joni mitchell!' })
  assert.equal(b.id, a.id)
  assert.equal(b.count, 2)
  const all = await s.listRequests()
  assert.equal(all.length, 1)
  // The most recent requester wins the display, so the operator sees it is freshly wanted.
  assert.equal(all[0].requester, 'p:bob')
})

test('different kind, name or artist does NOT fold', async (t) => {
  const s = await newState(t)
  await s.addRequest('p:alice', { kind: 'album', name: 'Blue', artist: 'Joni' })
  await s.addRequest('p:alice', { kind: 'track', name: 'Blue', artist: 'Joni' }) // kind differs
  await s.addRequest('p:alice', { kind: 'album', name: 'Clouds', artist: 'Joni' }) // name differs
  await s.addRequest('p:alice', { kind: 'album', name: 'Blue', artist: 'Eiffel 65' }) // artist differs
  assert.equal((await s.listRequests()).length, 4)
})

test('a RESOLVED request never folds - re-asking a fulfilled one is a new request', async (t) => {
  const s = await newState(t)
  const a = await s.addRequest('p:alice', { kind: 'track', name: 'Coyote', artist: 'Joni' })
  await s.resolveRequest(a.id, 'added')
  const b = await s.addRequest('p:bob', { kind: 'track', name: 'Coyote', artist: 'Joni' })
  assert.notEqual(b.id, a.id)
  assert.equal((await s.listRequests()).length, 2)
})

test('listRequests filters to a requester and sorts newest first', async (t) => {
  const s = await newState(t)
  const first = await s.addRequest('p:alice', { kind: 'album', name: 'A', artist: 'x' })
  // bump createdAt ordering deterministically: second call is later in wall-clock
  const second = await s.addRequest('p:alice', { kind: 'album', name: 'B', artist: 'x' })
  await s.addRequest('p:bob', { kind: 'album', name: 'C', artist: 'x' })
  const mine = await s.listRequests({ requester: 'p:alice' })
  assert.deepEqual(mine.map(r => r.name).sort(), ['A', 'B'])
  const all = await s.listRequests()
  assert.equal(all.length, 3)
  // newest first: whichever of first/second has the larger createdAt leads among alice's
  assert.ok(all[0].createdAt >= all[all.length - 1].createdAt)
  assert.ok(second.createdAt >= first.createdAt)
})

test('resolve is one-way and stamps resolvedAt', async (t) => {
  const s = await newState(t)
  const r = await s.addRequest('p:alice', { kind: 'artist', name: 'Nick Drake' })
  const done = await s.resolveRequest(r.id, 'added')
  assert.equal(done.status, 'added')
  assert.ok(done.resolvedAt)
  assert.equal(await s.resolveRequest('nope', 'added'), null) // unknown id
  await assert.rejects(() => s.resolveRequest(r.id, 'pending')) // cannot un-resolve
  await assert.rejects(() => s.resolveRequest(r.id, 'banana')) // bad status
})

test('a name is required; artist/album/mbid are optional and blank folds to null', async (t) => {
  const s = await newState(t)
  await assert.rejects(() => s.addRequest('p:alice', { kind: 'track', name: '   ' }))
  const r = await s.addRequest('p:alice', { kind: 'track', name: 'Solo' })
  assert.equal(r.artist, null)
  assert.equal(r.album, null)
  assert.equal(r.mbid, null)
})

test('a bad kind is refused', async (t) => {
  const s = await newState(t)
  await assert.rejects(() => s.addRequest('p:alice', { kind: 'genre', name: 'Jazz' }))
})

test('free-text fields are length-capped at the writer', async (t) => {
  const s = await newState(t)
  const r = await s.addRequest('p:alice', { kind: 'album', name: 'x'.repeat(5000) })
  assert.ok(r.name.length <= 200)
})

test('deleteRequest removes one row and reports whether it existed', async (t) => {
  const s = await newState(t)
  const r = await s.addRequest('p:alice', { kind: 'track', name: 'Coyote' })
  assert.equal(await s.deleteRequest(r.id), true)
  assert.equal(await s.getRequest(r.id), null)
  assert.equal(await s.deleteRequest(r.id), false) // already gone
  assert.equal((await s.listRequests()).length, 0)
})

test('deleting a person takes their requests with them', async (t) => {
  const s = await newState(t)
  await s.addRequest('p:alice', { kind: 'album', name: 'A' })
  await s.addRequest('p:alice', { kind: 'album', name: 'B' })
  await s.addRequest('p:bob', { kind: 'album', name: 'C' })
  await s.deleteOwner('p:alice')
  const left = await s.listRequests()
  assert.equal(left.length, 1)
  assert.equal(left[0].requester, 'p:bob')
})
