// The auth gate.
//
// Every branch of decide() gets a test, because this function is the only thing
// standing between a stranger and the library. And Connections gets tested
// separately, because a correct decide() with a broken registry means "revoked"
// devices keep playing music until they happen to reconnect - which is the exact
// failure mode holesail has and we exist to avoid.

const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('events')
const hcrypto = require('hypercore-crypto')
const z32 = require('z32')

const { decide, Connections } = require('../host/gate')

const NOW = 1_000_000
const okGrant = (over = {}) => ({
  deviceKey: 'abc',
  personId: null,
  revokedAt: null,
  expiresAt: null,
  scope: 'full',
  ...over
})

test('decide: no grant is denied', () => {
  assert.deepEqual(decide({ grant: null, person: null }, NOW), { allow: false, reason: 'no-grant' })
})

test('decide: a good grant is allowed', () => {
  assert.deepEqual(decide({ grant: okGrant(), person: null }, NOW), { allow: true, reason: 'ok' })
})

test('decide: a revoked device is denied', () => {
  const r = decide({ grant: okGrant({ revokedAt: NOW - 1 }), person: null }, NOW)
  assert.deepEqual(r, { allow: false, reason: 'device-revoked' })
})

test('decide: an expired grant is denied, and one expiring later is not', () => {
  assert.equal(decide({ grant: okGrant({ expiresAt: NOW - 1 }), person: null }, NOW).allow, false)
  assert.equal(decide({ grant: okGrant({ expiresAt: NOW + 1 }), person: null }, NOW).allow, true)
})

test('decide: a device of a revoked PERSON is denied even though its own grant is clean', () => {
  // The whole point of per-person revocation: one action kills every device that
  // person holds, without touching anyone else's.
  const r = decide({
    grant: okGrant({ personId: 'p1' }),
    person: { id: 'p1', revokedAt: NOW - 1 }
  }, NOW)
  assert.deepEqual(r, { allow: false, reason: 'person-revoked' })
})

test('decide: a device of a live person is allowed', () => {
  const r = decide({
    grant: okGrant({ personId: 'p1' }),
    person: { id: 'p1', revokedAt: null }
  }, NOW)
  assert.equal(r.allow, true)
})

test('decide: revocation beats everything else', () => {
  // A revoked grant that has not expired, for a live person, is still denied.
  const r = decide({
    grant: okGrant({ revokedAt: NOW - 1, expiresAt: NOW + 10_000, personId: 'p1' }),
    person: { id: 'p1', revokedAt: null }
  }, NOW)
  assert.equal(r.allow, false)
})

// --- the registry: revoke has to reach connections that are ALREADY open -----

function fakeConn () {
  const c = new EventEmitter()
  c.destroyed = false
  c.destroy = () => {
    c.destroyed = true
    c.emit('close')
  }
  return c
}

test('Connections: kill destroys every live connection for a device', () => {
  const conns = new Connections()
  const key = z32.encode(hcrypto.keyPair().publicKey)

  const a = fakeConn()
  const b = fakeConn()
  conns.add(key, a)
  conns.add(key, b)
  assert.equal(conns.count(key), 2)

  const killed = conns.kill(key)

  assert.equal(killed, 2)
  assert.equal(a.destroyed, true, 'first connection must be destroyed')
  assert.equal(b.destroyed, true, 'second connection must be destroyed')
  assert.equal(conns.count(key), 0)
})

test('Connections: killing one device does NOT disturb another', () => {
  // This is the requirement holesail structurally cannot meet. Revoking one
  // device must leave everyone else playing.
  const conns = new Connections()
  const mine = z32.encode(hcrypto.keyPair().publicKey)
  const theirs = z32.encode(hcrypto.keyPair().publicKey)

  const a = fakeConn()
  const b = fakeConn()
  conns.add(mine, a)
  conns.add(theirs, b)

  conns.kill(mine)

  assert.equal(a.destroyed, true)
  assert.equal(b.destroyed, false, 'an unrelated device must keep its connection')
  assert.equal(conns.count(theirs), 1)
})

test('Connections: a closed connection deregisters itself', () => {
  const conns = new Connections()
  const key = z32.encode(hcrypto.keyPair().publicKey)
  const a = fakeConn()
  conns.add(key, a)
  assert.equal(conns.size, 1)

  a.emit('close')

  assert.equal(conns.size, 0, 'a peer that hangs up must not leak a registry entry')
})

test('Connections: killing an unknown device is a no-op, not a throw', () => {
  const conns = new Connections()
  assert.equal(conns.kill(z32.encode(hcrypto.keyPair().publicKey)), 0)
})

test('Connections: killAll kills every device of a revoked person', () => {
  const conns = new Connections()
  const phone = z32.encode(hcrypto.keyPair().publicKey)
  const tablet = z32.encode(hcrypto.keyPair().publicKey)
  const bystander = z32.encode(hcrypto.keyPair().publicKey)

  const a = fakeConn(); const b = fakeConn(); const c = fakeConn()
  conns.add(phone, a)
  conns.add(tablet, b)
  conns.add(bystander, c)

  const killed = conns.killAll([phone, tablet])

  assert.equal(killed, 2)
  assert.equal(a.destroyed, true)
  assert.equal(b.destroyed, true)
  assert.equal(c.destroyed, false, 'a bystander must be untouched')
})
