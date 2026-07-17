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

const NAME_MAX = 64

// The host does not trust the phone to be polite. A name arrives over the wire from
// a device we have merely admitted, so it is trimmed, capped, and stripped of
// control characters HERE - at the authority - and not wherever it happens to be
// rendered. (It is escaped at render too. Belt and braces, on the page that holds
// the revoke buttons.)
function cleanName (s) {
  if (typeof s !== 'string') return ''
  // Control characters out first (a newline in a dashboard row, a NUL in a log
  // line), then trim, then cap - cap LAST, so a name padded with 200 spaces does
  // not survive as 64 spaces.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX)
}

class Grants {
  constructor (bee) {
    this.bee = bee
  }

  static keyOf (deviceKey) {
    return typeof deviceKey === 'string' ? deviceKey : z32.encode(deviceKey)
  }

  async addPerson (name) {
    const id = z32.encode(hcrypto.randomBytes(16))
    const person = { id, name: cleanName(name), createdAt: Date.now(), revokedAt: null }
    await this.bee.put('person:' + id, person, { valueEncoding: 'json' })
    return person
  }

  // The person of this name, or a new one. What "confirm this device's claim" runs:
  // two phones both claiming "Tim" must land on ONE Tim, not two.
  async personByName (name) {
    const clean = cleanName(name)
    if (!clean) return null
    const all = await this.listPersons()
    return all.find(p => !p.revokedAt && p.name.toLowerCase() === clean.toLowerCase()) || null
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

  async grant ({ deviceKey, personId = null, label = '', platform = '', scope = SCOPE.FULL, grantedBy = 'operator', expiresAt = null }) {
    const key = Grants.keyOf(deviceKey)
    const row = {
      deviceKey: key,
      personId,
      label,
      platform,
      scope,
      grantedAt: Date.now(),
      grantedBy,
      expiresAt, // null = never; a timestamp = a time-limited GUEST grant (gate.decide denies past it)
      paths: null, // reserved: v2 library-subset scopes
      revokedAt: null,
      lastSeenAt: null
    }
    await this.bee.put('grant:' + key, row, { valueEncoding: 'json' })
    return row
  }

  // Refresh a grant's expiry - what re-pairing an already-granted device through a GUEST
  // window does ("extend the pass" = scan again). Touches only expiresAt; personId, the
  // claim and the label are left exactly as they were. No-op on a missing or revoked row.
  async setExpiry (deviceKey, expiresAt) {
    const key = Grants.keyOf(deviceKey)
    const row = await this.get(key)
    if (!row || row.revokedAt) return null
    row.expiresAt = expiresAt
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

  // Remove a grant row ENTIRELY. This is the cleanup that stops the Devices list
  // growing without bound as revoked tombstones and pairing tests pile up.
  //
  // It is cleanup, NOT a second flavour of revoke, and the distinction is a SECURITY
  // one: we refuse to delete a LIVE grant. Deleting a live row would drop the device's
  // access with no tombstone - a revoke that forgot to kill the connection. So revoke
  // first (which tombstones AND cuts the live connection), and only THEN may the
  // revoked row be deleted. Deleting never re-admits: with the row gone, lookup()
  // returns no grant and the gate denies by default (fail-closed, gate.js decide()).
  // A deleted device must pair again to return, exactly like one that never paired.
  async deleteGrant (deviceKey) {
    const key = Grants.keyOf(deviceKey)
    const row = await this.get(key)
    if (!row || !row.revokedAt) return null
    await this.bee.del('grant:' + key)
    return row
  }

  // Remove a person row - only an EMPTY one, holding no device that still has access.
  // Refusing while a live device points here means we never orphan a live grant's
  // personId or lose the subject of a "revoke this person" action. Revoked devices may
  // still point at a deleted person; that pointer is cosmetic (they are denied
  // regardless) and the dashboard tolerates a missing person.
  async deletePerson (personId) {
    const person = await this.getPerson(personId)
    if (!person) return null
    const holdsLive = (await this.list()).some(g => g.personId === personId && !g.revokedAt)
    if (holdsLive) return null
    await this.bee.del('person:' + personId)
    return person
  }

  // Rename a person from the dashboard - the direct "rename" the UI lacked (you used
  // to get here only by re-confirming a device's new claim). Returns the updated row,
  // null if no such person, or throws on a bad/colliding name.
  //
  // Two invariants it must keep:
  // 1. The name is the JOIN KEY personByName uses to turn a claim into an assignment
  //    ("one Tim, not two"). So a blank name is refused, and a name that collides with
  //    a DIFFERENT live person is refused - otherwise a later claim would be ambiguous.
  // 2. Assigned devices carry a claimedUser (the name they claimed). If we renamed the
  //    person and left those alone, the dashboard's claimMismatch would fire and the
  //    devices would drop out of the person and reappear under "Needs confirmation" - and
  //    the phone would read as unconfirmed. So we sync claimedUser on this person's live
  //    devices to the new name. This is safe here BECAUSE it is the OPERATOR renaming a
  //    person, not a device self-claiming (which must still stay pending) - the operator
  //    is the authority on who a confirmed device belongs to.
  async renamePerson (personId, name) {
    const person = await this.getPerson(personId)
    if (!person) return null
    const clean = cleanName(name)
    if (!clean) throw new Error('name required')

    const clash = (await this.listPersons()).find(
      p => p.id !== personId && !p.revokedAt && p.name.toLowerCase() === clean.toLowerCase()
    )
    if (clash) throw new Error('another person already has that name')

    person.name = clean
    await this.bee.put('person:' + personId, person, { valueEncoding: 'json' })

    for (const g of await this.list()) {
      if (g.personId === personId && !g.revokedAt && g.claimedUser && g.claimedUser !== clean) {
        g.claimedUser = clean
        await this.bee.put('grant:' + Grants.keyOf(g.deviceKey), g, { valueEncoding: 'json' })
      }
    }
    return person
  }

  // Attach a device to a person (or detach, with personId = null). This is what
  // makes "revoke that friend, not my tablet" possible: revocation then has a
  // subject a human recognises instead of a 52-character key.
  async assign (deviceKey, personId) {
    const key = Grants.keyOf(deviceKey)
    const row = await this.get(key)
    if (!row) return null

    if (personId) {
      const person = await this.getPerson(personId)
      if (!person) throw new Error('no such person')
      // Assigning a device to a REVOKED person would silently lock it out, which
      // looks like a bug to whoever just did it. Refuse instead.
      if (person.revokedAt) throw new Error('that person is revoked')
    }

    row.personId = personId || null
    await this.bee.put('grant:' + key, row, { valueEncoding: 'json' })
    return row
  }

  // --- the only two things a DEVICE may write about itself --------------------
  //
  // The grant store is the host's authority. These are the first methods a client
  // can reach, so the rules are narrow on purpose (proposal 2026-07-14):
  //
  //   1. The caller is identified by the NOISE-AUTHENTICATED public key of its
  //      connection. There is no deviceKey parameter, so there is nothing to forge:
  //      a device can only ever write its own row.
  //   2. A device may NOT set personId. It may CLAIM a name; only the operator can
  //      turn a claim into an assignment.
  //   3. A claim grants nothing. It is cosmetic until confirmed.
  //
  // Today personId only affects revoke-by-person, so self-assignment would be
  // harmless. The moment per-person scopes, playlists or history exist, a device
  // that can attach itself to any person by name is a privilege escalation.
  // Self-declared identity must not become authority.
  async setIdentity (deviceKey, { deviceName, userName } = {}) {
    const key = Grants.keyOf(deviceKey)
    const row = await this.get(key)
    if (!row || row.revokedAt) return null

    if (deviceName !== undefined) {
      const clean = cleanName(deviceName)
      if (clean) row.label = clean
    }

    if (userName !== undefined) {
      const clean = cleanName(userName)
      row.claimedUser = clean || null
      row.claimedAt = clean ? Date.now() : null
      // NOT row.personId. See above.
    }

    await this.bee.put('grant:' + key, row, { valueEncoding: 'json' })
    return row
  }

  // The operator turning a device's CLAIM into a real assignment. Joins an existing
  // person of that name rather than minting a second one, so two phones both
  // claiming "Tim" end up under one Tim.
  async confirmClaim (deviceKey) {
    const key = Grants.keyOf(deviceKey)
    const row = await this.get(key)
    if (!row || !row.claimedUser) return null

    const person = (await this.personByName(row.claimedUser)) ||
      (await this.addPerson(row.claimedUser))

    return this.assign(key, person.id)
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
