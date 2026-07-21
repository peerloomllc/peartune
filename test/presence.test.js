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

test('a buffer deviceKey and its z32 string address the same device', (t) => {
  const p = new Presence()
  const raw = Buffer.alloc(32, 7)
  let hits = 0
  p.register(raw, () => { hits++ })           // registered by buffer
  p.notify(z32.encode(raw), 'session-superseded') // notified by the z32 string a grant carries
  assert.equal(hits, 1)
})
