// The grant store, including per-person assignment.
//
// The "revoke a person, not a key" story is the reason we built our own host
// instead of using holesail, so it gets real coverage rather than a smoke test.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const hcrypto = require('hypercore-crypto')
const z32 = require('z32')

const { Grants } = require('../host/grants')
const { decide } = require('../host/gate')

async function store (t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-grants-'))
  const cs = new Corestore(dir)
  const bee = new Hyperbee(cs.get({ name: 'g' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.ready()
  t.after(async () => {
    await bee.close()
    await cs.close()
    await fsp.rm(dir, { recursive: true, force: true })
  })
  return new Grants(bee)
}

const key = () => z32.encode(hcrypto.keyPair().publicKey)

test('a device can be assigned to a person, and detached again', async (t) => {
  const g = await store(t)
  const ada = await g.addPerson('Ada')
  const dev = await g.grant({ deviceKey: key(), label: 'phone' })

  const assigned = await g.assign(dev.deviceKey, ada.id)
  assert.equal(assigned.personId, ada.id)

  const detached = await g.assign(dev.deviceKey, null)
  assert.equal(detached.personId, null)
})

test('revoking a PERSON revokes every device they hold, and nobody else', async (t) => {
  const g = await store(t)
  const ada = await g.addPerson('Ada')

  const phone = await g.grant({ deviceKey: key(), label: "Ada's phone" })
  const tablet = await g.grant({ deviceKey: key(), label: "Ada's tablet" })
  const mine = await g.grant({ deviceKey: key(), label: 'my phone' })

  await g.assign(phone.deviceKey, ada.id)
  await g.assign(tablet.deviceKey, ada.id)

  const revoked = await g.revokePerson(ada.id)
  assert.equal(revoked.length, 2, 'both of her devices')

  // Her devices are denied...
  for (const k of [phone.deviceKey, tablet.deviceKey]) {
    assert.equal(decide(await g.lookup(k)).allow, false)
  }
  // ...and mine is untouched. This is the whole point.
  assert.equal(decide(await g.lookup(mine.deviceKey)).allow, true)
})

test('a device of a revoked person is denied even if its OWN grant is clean', async (t) => {
  const g = await store(t)
  const ada = await g.addPerson('Ada')
  const dev = await g.grant({ deviceKey: key(), label: 'phone' })
  await g.assign(dev.deviceKey, ada.id)

  // Revoke the person, then hand the device a fresh, unrevoked grant row. The
  // person-level revocation must still win, or "revoke Ada" would be undone by
  // Ada simply re-pairing.
  await g.revokePerson(ada.id)
  const row = await g.get(dev.deviceKey)
  row.revokedAt = null
  await g.bee.put('grant:' + dev.deviceKey, row, { valueEncoding: 'json' })

  const { allow, reason } = decide(await g.lookup(dev.deviceKey))
  assert.equal(allow, false)
  assert.equal(reason, 'person-revoked')
})

test('assigning a device to a REVOKED person is refused, not silently accepted', async (t) => {
  const g = await store(t)
  const ada = await g.addPerson('Ada')
  const dev = await g.grant({ deviceKey: key(), label: 'phone' })
  await g.revokePerson(ada.id)

  // Silently accepting would lock the device out with no visible cause, which
  // looks like a bug to whoever just did it.
  await assert.rejects(() => g.assign(dev.deviceKey, ada.id), /revoked/)
})

test('assigning to a person who does not exist is refused', async (t) => {
  const g = await store(t)
  const dev = await g.grant({ deviceKey: key(), label: 'phone' })
  await assert.rejects(() => g.assign(dev.deviceKey, 'nope'), /no such person/)
})

test('assigning an unknown device is a null, not a throw', async (t) => {
  const g = await store(t)
  const ada = await g.addPerson('Ada')
  assert.equal(await g.assign(key(), ada.id), null)
})

// --- deletion (dashboard cleanup, must never re-admit) ----------------------

test('a REVOKED device can be deleted, and stays denied afterwards', async (t) => {
  const g = await store(t)
  const dev = await g.grant({ deviceKey: key(), label: 'old phone' })
  await g.revoke(dev.deviceKey)

  const gone = await g.deleteGrant(dev.deviceKey)
  assert.equal(gone.deviceKey, dev.deviceKey)
  assert.equal(await g.get(dev.deviceKey), null, 'row is gone from the store')

  // The whole security point: a deleted row is no grant, and no grant is denied by
  // default (fail-closed). Deleting must never resurrect access.
  assert.equal(decide(await g.lookup(dev.deviceKey)).allow, false)
  assert.equal(decide(await g.lookup(dev.deviceKey)).reason, 'no-grant')
})

test('deleting a LIVE grant is refused (revoke first)', async (t) => {
  const g = await store(t)
  const dev = await g.grant({ deviceKey: key(), label: 'phone' })

  // A live row deleted would drop access with no tombstone - a revoke that forgot to
  // kill the connection. Refuse it: the row must still be there, still admitting.
  assert.equal(await g.deleteGrant(dev.deviceKey), null)
  assert.notEqual(await g.get(dev.deviceKey), null)
  assert.equal(decide(await g.lookup(dev.deviceKey)).allow, true)
})

test('deleting an unknown device is a null, not a throw', async (t) => {
  const g = await store(t)
  assert.equal(await g.deleteGrant(key()), null)
})

test('an EMPTY person can be deleted', async (t) => {
  const g = await store(t)
  const ada = await g.addPerson('Ada')

  const gone = await g.deletePerson(ada.id)
  assert.equal(gone.id, ada.id)
  assert.equal(await g.getPerson(ada.id), null)
})

test('deleting a person who still holds a LIVE device is refused', async (t) => {
  const g = await store(t)
  const ada = await g.addPerson('Ada')
  const dev = await g.grant({ deviceKey: key(), label: 'phone' })
  await g.assign(dev.deviceKey, ada.id)

  // Deleting would orphan the live device's personId and lose the revoke subject.
  assert.equal(await g.deletePerson(ada.id), null)
  assert.notEqual(await g.getPerson(ada.id), null)
})

test('renamePerson changes the name and sanitizes it', async (t) => {
  const g = await store(t)
  const ada = await g.addPerson('Ada')

  const row = await g.renamePerson(ada.id, '  Ada Lovelace\n  ')
  assert.equal(row.name, 'Ada Lovelace') // trimmed + control chars stripped
  assert.equal((await g.getPerson(ada.id)).name, 'Ada Lovelace')
})

test('renamePerson refuses a blank name and a missing person', async (t) => {
  const g = await store(t)
  const ada = await g.addPerson('Ada')

  await assert.rejects(() => g.renamePerson(ada.id, '   '), /name required/)
  assert.equal(await g.renamePerson('nope', 'Whoever'), null) // no such person
  assert.equal((await g.getPerson(ada.id)).name, 'Ada') // unchanged
})

test('renamePerson refuses colliding with another live person (the "one Tim" rule)', async (t) => {
  const g = await store(t)
  const ada = await g.addPerson('Ada')
  await g.addPerson('Grace')

  // personByName joins a claim to a person by name, so two live Graces would be ambiguous.
  await assert.rejects(() => g.renamePerson(ada.id, 'grace'), /already has that name/)
  assert.equal((await g.getPerson(ada.id)).name, 'Ada')
})

test('renamePerson keeps assigned devices confirmed (syncs their claim to the new name)', async (t) => {
  const g = await store(t)
  const dev = await g.grant({ deviceKey: key(), label: 'phone' })
  await g.setIdentity(dev.deviceKey, { userName: 'Tim' })
  const person = await g.confirmClaim(dev.deviceKey) // creates "Tim", assigns the device

  await g.renamePerson(person.personId, 'Timothy')

  const row = await g.get(dev.deviceKey)
  // Claim followed the rename, so the dashboard's claimMismatch stays false (the device
  // remains under the person instead of dropping into "Needs confirmation").
  assert.equal(row.claimedUser, 'Timothy')
  assert.equal(row.personId, person.personId)
})

test('a person whose only devices are REVOKED can be deleted', async (t) => {
  const g = await store(t)
  const ada = await g.addPerson('Ada')
  const dev = await g.grant({ deviceKey: key(), label: 'phone' })
  await g.assign(dev.deviceKey, ada.id)
  await g.revoke(dev.deviceKey)

  // No LIVE device holds her, so the empty row can go.
  const gone = await g.deletePerson(ada.id)
  assert.equal(gone.id, ada.id)
})

// --- guest grants: time-limited access ---------------------------------------

test('grant() stamps expiresAt when given one, and the gate then denies it once past', async (t) => {
  const g = await store(t)
  const key = z32.encode(hcrypto.keyPair().publicKey)
  const expiresAt = Date.now() + 60_000
  const row = await g.grant({ deviceKey: key, label: 'Guest phone', grantedBy: 'qr-guest', expiresAt })

  assert.equal(row.expiresAt, expiresAt)
  assert.equal(row.grantedBy, 'qr-guest')

  const lookup = await g.lookup(key)
  assert.equal(decide(lookup, expiresAt - 1).allow, true, 'valid before expiry')
  assert.equal(decide(lookup, expiresAt + 1).allow, false, 'denied after expiry')
})

test('grant() defaults to no expiry (permanent), unchanged', async (t) => {
  const g = await store(t)
  const key = z32.encode(hcrypto.keyPair().publicKey)
  const row = await g.grant({ deviceKey: key, label: 'My phone' })
  assert.equal(row.expiresAt, null)
  assert.equal(decide(await g.lookup(key), Date.now() + 10 * 365 * 24 * 3600_000).allow, true)
})

test('setExpiry() refreshes a guest pass without touching the claim, and no-ops on missing/revoked', async (t) => {
  const g = await store(t)
  const key = z32.encode(hcrypto.keyPair().publicKey)
  await g.grant({ deviceKey: key, label: 'Guest', personId: 'p1', expiresAt: Date.now() + 1000 })

  const later = Date.now() + 999_999
  const row = await g.setExpiry(key, later)
  assert.equal(row.expiresAt, later)
  assert.equal(row.personId, 'p1', 'the person is left alone')
  assert.equal(row.label, 'Guest', 'the label is left alone')

  // missing device
  assert.equal(await g.setExpiry(z32.encode(hcrypto.keyPair().publicKey), later), null)
  // revoked device
  await g.revoke(key)
  assert.equal(await g.setExpiry(key, later + 1), null, 'a revoked grant is not re-extended')
})

// --- auto-person on a NEW claim (proposal 2026-07-21) -------------------------

test('setIdentity auto-creates + assigns a person for a NEW claim on an unassigned device', async (t) => {
  const g = await store(t)
  const dev = await g.grant({ deviceKey: key(), label: 'phone' })
  assert.equal(dev.personId, null)

  const row = await g.setIdentity(dev.deviceKey, { deviceName: 'Pixel', userName: 'Tim' })
  assert.equal(row.label, 'Pixel')
  assert.equal(row.claimedUser, 'Tim')
  assert.ok(row.personId, 'a new person was minted and assigned')
  const person = await g.getPerson(row.personId)
  assert.equal(person.name, 'Tim')
})

test('setIdentity leaves a claim PENDING when a person of that name already exists (join needs confirm)', async (t) => {
  const g = await store(t)
  const tim = await g.addPerson('Tim') // person already exists
  const dev = await g.grant({ deviceKey: key(), label: 'tablet' })

  const row = await g.setIdentity(dev.deviceKey, { userName: 'Tim' })
  assert.equal(row.claimedUser, 'Tim')
  assert.equal(row.personId, null, 'joining an EXISTING person stays pending until the operator confirms')

  // confirmClaim then joins the SAME person, not a second one.
  const confirmed = await g.confirmClaim(dev.deviceKey)
  assert.equal(confirmed.personId, tim.id)
  assert.equal((await g.listPersons()).filter((p) => p.name === 'Tim').length, 1, 'still one Tim')
})

test('setIdentity never auto-REASSIGNS an already-assigned device on a claim change', async (t) => {
  const g = await store(t)
  const ada = await g.addPerson('Ada')
  const dev = await g.grant({ deviceKey: key(), label: 'phone' })
  await g.assign(dev.deviceKey, ada.id)

  // A new, non-existent name from an ALREADY-assigned device: the claim updates, but the
  // assignment does NOT move on its own (a rename is a pending re-claim for the operator).
  const row = await g.setIdentity(dev.deviceKey, { userName: 'Grace' })
  assert.equal(row.claimedUser, 'Grace')
  assert.equal(row.personId, ada.id, 'still assigned to Ada; not silently reassigned')
  assert.equal(await g.personByName('Grace'), null, 'no stray Grace person minted')
})

test('setIdentity with a blank claim assigns nobody', async (t) => {
  const g = await store(t)
  const dev = await g.grant({ deviceKey: key(), label: 'phone' })
  const row = await g.setIdentity(dev.deviceKey, { userName: '   ' })
  assert.equal(row.claimedUser, null)
  assert.equal(row.personId, null)
})
