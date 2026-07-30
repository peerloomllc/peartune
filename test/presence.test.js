// Presence: the server->client push registry for session handoff (host/presence.js).
//
// It is the ONE place the host speaks unsolicited, so the properties worth pinning are: a
// notify reaches every live connection of a device, an unregistered (closed) channel is never
// pushed to, and a device with no live connection notifies nobody (returns 0, not a throw).

const test = require('node:test')
const assert = require('node:assert/strict')
const z32 = require('z32')

const { Presence } = require('../host/presence')

test('notify reaches every registered sender for a device and reports the count', (t) => {
  const p = new Presence()
  const got = []
  p.register('PHONE', (e) => got.push(['a', e]))
  p.register('PHONE', (e) => got.push(['b', e])) // a reconnect can briefly hold two channels
  const n = p.notify('PHONE', 'session-superseded', { generation: 3 })
  assert.equal(n, 2)
  assert.deepEqual(got, [
    ['a', { kind: 'session-superseded', data: { generation: 3 } }],
    ['b', { kind: 'session-superseded', data: { generation: 3 } }]
  ])
})

test('a device targets only ITS OWN senders, not another device', (t) => {
  const p = new Presence()
  let phone = 0
  let tablet = 0
  p.register('PHONE', () => { phone++ })
  p.register('TABLET', () => { tablet++ })
  p.notify('PHONE', 'session-superseded')
  assert.equal(phone, 1)
  assert.equal(tablet, 0)
})

test('unregister drops the sender - a closed channel is never pushed to', (t) => {
  const p = new Presence()
  let hits = 0
  const off = p.register('PHONE', () => { hits++ })
  assert.equal(p.count('PHONE'), 1)
  off()
  assert.equal(p.count('PHONE'), 0)
  assert.equal(p.notify('PHONE', 'session-superseded'), 0) // nobody left
  assert.equal(hits, 0)
})

test('notify on a device with no live connection is a no-op, not a throw', (t) => {
  const p = new Presence()
  assert.equal(p.notify('GHOST', 'session-superseded'), 0)
})

test('a throwing sender does not stop the others (and does not throw out)', (t) => {
  const p = new Presence()
  let good = 0
  p.register('PHONE', () => { throw new Error('channel closed a tick ago') })
  p.register('PHONE', () => { good++ })
  const n = p.notify('PHONE', 'session-superseded')
  assert.equal(good, 1)
  assert.equal(n, 1) // only the surviving sender counts
})

test('notifyAll reaches every connection of every device and reports the total', (t) => {
  const p = new Presence()
  const got = []
  p.register('PHONE', (e) => got.push(['phone-a', e]))
  p.register('PHONE', (e) => got.push(['phone-b', e])) // one device, two live channels
  p.register('TABLET', (e) => got.push(['tablet', e]))
  const n = p.notifyAll('library-renamed', { libraryId: 'lib1', libraryName: 'Tim’s Umbrel' })
  assert.equal(n, 3) // both phone channels + the tablet
  assert.deepEqual(got.map((g) => g[0]).sort(), ['phone-a', 'phone-b', 'tablet'])
  for (const [, e] of got) {
    assert.equal(e.kind, 'library-renamed')
    assert.deepEqual(e.data, { libraryId: 'lib1', libraryName: 'Tim’s Umbrel' })
  }
})

test('notifyAll with nobody connected is a no-op, not a throw', (t) => {
  const p = new Presence()
  assert.equal(p.notifyAll('library-renamed', { libraryId: 'lib1' }), 0)
})

test('notifyAll swallows a throwing sender and still reaches the rest', (t) => {
  const p = new Presence()
  let good = 0
  p.register('PHONE', () => { throw new Error('channel closed a tick ago') })
  p.register('TABLET', () => { good++ })
  const n = p.notifyAll('library-renamed', { libraryId: 'lib1' })
  assert.equal(good, 1)
  assert.equal(n, 1) // only the surviving sender counts
})

test('notifyOwner reaches every device of one PERSON, keyed by ownerId', (t) => {
  const p = new Presence()
  const got = []
  // Same person signed in on two devices (phone + tablet), plus a different person's phone.
  p.register('PHONE', (e) => got.push(['phone', e]), 'p:sam')
  p.register('TABLET', (e) => got.push(['tablet', e]), 'p:sam')
  p.register('OTHER', (e) => got.push(['other', e]), 'p:kim')
  const n = p.notifyOwner('p:sam', 'request:resolved', { id: 'r1', status: 'added' })
  assert.equal(n, 2) // both of Sam's devices, not Kim's
  assert.deepEqual(got.map((g) => g[0]).sort(), ['phone', 'tablet'])
  for (const [, e] of got) {
    assert.equal(e.kind, 'request:resolved')
    assert.deepEqual(e.data, { id: 'r1', status: 'added' })
  }
})

// The favorites push (proposal 2026-07-30-favorites-live-update) is news to a person's OTHER
// phones and not to the one that just tapped the heart - that one already re-rendered, and
// pushing to it would fight its own optimistic update.
test('notifyOwner skips exceptDevice - the device that MADE the change is not told about it', (t) => {
  const p = new Presence()
  const got = []
  p.register('PHONE', (e) => got.push(['phone', e]), 'p:sam')
  p.register('TABLET', (e) => got.push(['tablet', e]), 'p:sam')
  p.register('OTHER', (e) => got.push(['other', e]), 'p:kim')

  const n = p.notifyOwner('p:sam', 'favorites:changed', { kind: 'artist', id: 'a1', on: true }, { exceptDevice: 'PHONE' })
  assert.equal(n, 1, "only Sam's other device")
  assert.deepEqual(got.map((g) => g[0]), ['tablet'])
  assert.deepEqual(got[0][1].data, { kind: 'artist', id: 'a1', on: true })
})

test('notifyOwner with a SECOND connection of the excepted device skips them all', (t) => {
  // One device can hold more than one live connection (a reconnect briefly overlaps the old one),
  // and every one of them is the same phone - so the exception has to be per DEVICE, not per
  // channel, or the tapping phone still hears about its own write down the other pipe.
  const p = new Presence()
  const got = []
  p.register('PHONE', (e) => got.push('phone-a'), 'p:sam')
  p.register('PHONE', (e) => got.push('phone-b'), 'p:sam')
  p.register('TABLET', (e) => got.push('tablet'), 'p:sam')
  assert.equal(p.notifyOwner('p:sam', 'favorites:changed', null, { exceptDevice: 'PHONE' }), 1)
  assert.deepEqual(got, ['tablet'])
})

test('notifyOwner with no exceptDevice still reaches everyone (request:resolved is unchanged)', (t) => {
  const p = new Presence()
  let hits = 0
  p.register('PHONE', () => { hits++ }, 'p:sam')
  p.register('TABLET', () => { hits++ }, 'p:sam')
  assert.equal(p.notifyOwner('p:sam', 'request:resolved', { id: 'r1' }), 2)
  assert.equal(hits, 2)
})

test('notifyOwner for an ownerId with nobody connected is a no-op, not a throw', (t) => {
  const p = new Presence()
  p.register('PHONE', () => {}, 'p:sam')
  assert.equal(p.notifyOwner('p:ghost', 'request:resolved'), 0)
})

test('a channel registered with no ownerId is unreachable by notifyOwner', (t) => {
  const p = new Presence()
  let hits = 0
  p.register('PHONE', () => { hits++ }) // handoff-style registration, device-only
  assert.equal(p.notifyOwner('p:sam', 'request:resolved'), 0)
  assert.equal(hits, 0)
})

test('unregister drops a channel from BOTH the device and the owner index', (t) => {
  const p = new Presence()
  let hits = 0
  const off = p.register('PHONE', () => { hits++ }, 'p:sam')
  off()
  assert.equal(p.notify('PHONE', 'request:new'), 0)       // gone from _byDevice
  assert.equal(p.notifyOwner('p:sam', 'request:resolved'), 0) // and from _byOwner
  assert.equal(hits, 0)
})

test('a buffer deviceKey and its z32 string address the same device', (t) => {
  const p = new Presence()
  const raw = Buffer.alloc(32, 7)
  let hits = 0
  p.register(raw, () => { hits++ })           // registered by buffer
  p.notify(z32.encode(raw), 'session-superseded') // notified by the z32 string a grant carries
  assert.equal(hits, 1)
})
