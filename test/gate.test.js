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

const { decide, sweepKills, carryOverPerson, Connections } = require('../host/gate')

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

// --- sweepKills (the expiry sweep's selection) -------------------------------
//
// The sweep is what makes a guest grant expire while CONNECTED, not just at the next
// connect. Its selection is pure, so every case is pinned here.

test('sweepKills: a live device whose grant just expired is cut', () => {
  const key = 'guest'
  const lookups = new Map([[key, { grant: okGrant({ expiresAt: NOW - 1 }), person: null }]])
  assert.deepEqual(sweepKills([key], lookups, NOW), [key])
})

test('sweepKills: a live device whose grant is still valid is left alone', () => {
  const key = 'guest'
  const lookups = new Map([[key, { grant: okGrant({ expiresAt: NOW + 10_000 }), person: null }]])
  assert.deepEqual(sweepKills([key], lookups, NOW), [])
})

test('sweepKills: a permanent (never-expiring) grant is never swept', () => {
  const key = 'owner'
  const lookups = new Map([[key, { grant: okGrant({ expiresAt: null }), person: null }]])
  assert.deepEqual(sweepKills([key], lookups, NOW), [])
})

test('sweepKills: only the expired ones among many are returned', () => {
  const lookups = new Map([
    ['a', { grant: okGrant({ expiresAt: NOW - 1 }), person: null }], // expired
    ['b', { grant: okGrant({ expiresAt: NOW + 10_000 }), person: null }], // valid
    ['c', { grant: okGrant({ expiresAt: null }), person: null }], // permanent
    ['d', { grant: okGrant({ revokedAt: NOW - 1 }), person: null }] // revoked (belt-and-braces)
  ])
  assert.deepEqual(sweepKills(['a', 'b', 'c', 'd'], lookups, NOW).sort(), ['a', 'd'])
})

test('sweepKills: a live device with no grant at all is cut (fail-closed)', () => {
  const lookups = new Map() // nothing known about this key
  assert.deepEqual(sweepKills(['ghost'], lookups, NOW), ['ghost'])
})

// --- carryOverPerson: may a returning device inherit its old person? ---------
//
// The rule is deliberately narrow, and every way of NOT qualifying is pinned here:
// this is the one place that can hand an identity back without an operator click.

const TIM = { id: 'p1', name: 'Tim', revokedAt: null }
const left = (over = {}) => ({
  deviceKey: 'abc', personId: 'p1', claimedUser: 'Tim',
  revokedAt: NOW - 10, revokedBy: 'self', ...over
})

test('carryOverPerson: a device that LEFT BY ITSELF comes back to its person', () => {
  assert.equal(carryOverPerson(left(), TIM), 'p1')
})

test('carryOverPerson: an OPERATOR revoke does not - that checkpoint is the point of revoke', () => {
  assert.equal(carryOverPerson(left({ revokedBy: 'operator' }), TIM), null)
})

test('carryOverPerson: revoking the whole PERSON does not bring its devices back', () => {
  assert.equal(carryOverPerson(left({ revokedBy: 'person' }), TIM), null)
})

test('carryOverPerson: a tombstone from BEFORE revokedBy existed does not carry over', () => {
  // Every grant already on disk when this shipped looks like this. Undefined is not
  // 'self', so nothing in the field changes behaviour.
  const old = left()
  delete old.revokedBy
  assert.equal(carryOverPerson(old, TIM), null)
})

test('carryOverPerson: nothing to return to - person deleted, or revoked meanwhile', () => {
  assert.equal(carryOverPerson(left(), null), null, 'deleted while the device was away')
  assert.equal(carryOverPerson(left(), { ...TIM, revokedAt: NOW }), null, 'revoked while away')
})

test('carryOverPerson: an unassigned device, and a LIVE grant, carry nothing', () => {
  assert.equal(carryOverPerson(left({ personId: null }), TIM), null, 'it belonged to nobody')
  assert.equal(carryOverPerson(left({ revokedAt: null }), TIM), null, 'not a tombstone at all')
  assert.equal(carryOverPerson(null, TIM), null, 'never paired here before')
})

test('carryOverPerson: the loaded person must be the one the grant points at', () => {
  // A caller that loaded the wrong row must not silently attach the device to it.
  assert.equal(carryOverPerson(left(), { id: 'p2', name: 'Someone else', revokedAt: null }), null)
})

test('Connections: deviceKeys lists exactly the devices holding a live connection', () => {
  const conns = new Connections()
  const phone = z32.encode(hcrypto.keyPair().publicKey)
  const tablet = z32.encode(hcrypto.keyPair().publicKey)
  const a = fakeConn(); const b = fakeConn()
  conns.add(phone, a)
  conns.add(tablet, b)
  assert.deepEqual(conns.deviceKeys().sort(), [phone, tablet].sort())
  a.emit('close')
  assert.deepEqual(conns.deviceKeys(), [tablet])
})
