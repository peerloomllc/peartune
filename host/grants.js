// The grant store: who is allowed to reach this library.
//
// HOST-LOCAL AND NEVER REPLICATED. This is the load-bearing rule of the whole
// design (CLAUDE.md, DECISIONS 2026-07-13). If the allow-list lived in the
// shared Autobase ledger, a revoked device would still hold a writer key and
// could simply append a row putting itself back on the list. The host is the
// sole authority on admission, and the only way to change that list is to be
// the operator, on the host, with the dashboard open.
//
// Rows:
//   person:{personId}  -> { id, name, createdAt, revokedAt }
//   grant:{deviceKey}  -> { deviceKey, personId, label, platform, scope,
//                           grantedAt, grantedBy, expiresAt, paths,
//                           revokedAt, lastSeenAt }
//
// `expiresAt` and `paths` are reserved nulls: v2 guest grants and library-subset
// scopes are then a value change, not a schema migration (proposal, Compat).

const z32 = require('z32')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const { SCOPE } = require('../protocol/constants')

class Grants {
  constructor (bee) {
    this.bee = bee
  }

  static keyOf (deviceKey) {
    return typeof deviceKey === 'string' ? deviceKey : z32.encode(deviceKey)
  }

  async addPerson (name) {
    const id = z32.encode(hcrypto.randomBytes(16))
    const person = { id, name, createdAt: Date.now(), revokedAt: null }
    await this.bee.put('person:' + id, person, { valueEncoding: 'json' })
    return person
  }

  async getPerson (personId) {
    if (!personId) return null
    const node = await this.bee.get('person:' + personId, { valueEncoding: 'json' })
    return node ? node.value : null
  }

  async listPersons () {
    const out = []
    for await (const node of this.bee.createReadStream({ gte: 'person:', lt: 'person;' }, { valueEncoding: 'json' })) {
      out.push(node.value)
    }
    return out
  }

  async grant ({ deviceKey, personId = null, label = '', platform = '', scope = SCOPE.FULL, grantedBy = 'operator' }) {
    const key = Grants.keyOf(deviceKey)
    const row = {
      deviceKey: key,
      personId,
      label,
      platform,
      scope,
      grantedAt: Date.now(),
      grantedBy,
      expiresAt: null, // reserved: v2 time-limited guest grants
      paths: null, // reserved: v2 library-subset scopes
      revokedAt: null,
      lastSeenAt: null
    }
    await this.bee.put('grant:' + key, row, { valueEncoding: 'json' })
    return row
  }

  async get (deviceKey) {
    const node = await this.bee.get('grant:' + Grants.keyOf(deviceKey), { valueEncoding: 'json' })
    return node ? node.value : null
  }

  async list () {
    const out = []
    for await (const node of this.bee.createReadStream({ gte: 'grant:', lt: 'grant;' }, { valueEncoding: 'json' })) {
      out.push(node.value)
    }
    return out
  }

  // Tombstone rather than delete. We want the dashboard to be able to show "this
  // device WAS allowed and is not any more", and a deleted row is indistinguish-
  // able from a device that never paired.
  async revoke (deviceKey) {
    const key = Grants.keyOf(deviceKey)
    const row = await this.get(key)
    if (!row || row.revokedAt) return null
    row.revokedAt = Date.now()
    await this.bee.put('grant:' + key, row, { valueEncoding: 'json' })
    return row
  }

  // Revoking a person revokes every device they hold, in one action. This is the
  // case holesail structurally cannot serve, and the reason we built the host.
  async revokePerson (personId) {
    const person = await this.getPerson(personId)
    if (!person) return []
    person.revokedAt = Date.now()
    await this.bee.put('person:' + personId, person, { valueEncoding: 'json' })

    const revoked = []
    for (const g of await this.list()) {
      if (g.personId === personId && !g.revokedAt) {
        const r = await this.revoke(g.deviceKey)
        if (r) revoked.push(r)
      }
    }
    return revoked
  }

  async touch (deviceKey) {
    const row = await this.get(deviceKey)
    if (!row) return
    row.lastSeenAt = Date.now()
    await this.bee.put('grant:' + Grants.keyOf(deviceKey), row, { valueEncoding: 'json' })
  }

  // The single source of truth for "may this key connect", used by the firewall.
  // Pure-ish and async because the store is a Hyperbee; the decision logic itself
  // is in gate.js so it can be unit-tested without a Hyperbee at all.
  async lookup (deviceKey) {
    const grant = await this.get(deviceKey)
    if (!grant) return { grant: null, person: null }
    const person = grant.personId ? await this.getPerson(grant.personId) : null
    return { grant, person }
  }
}

module.exports = { Grants, b4a }
