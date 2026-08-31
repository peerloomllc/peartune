// The auth gate.
//
// Two halves, and BOTH are required. Shipping only the first is the bug this
// file exists to prevent:
//
//   1. `decide()` - who may OPEN a connection. Wired into HyperDHT's
//      `createServer({ firewall })`, which runs once, at connect time.
//
//   2. `Connections` - who may KEEP one. The firewall hook never runs again for
//      the life of a connection, so revoking a phone that is mid-song would do
//      exactly nothing until it happened to reconnect. The registry tracks every
//      live connection per device so revoke can destroy them immediately.
//
// "Revoke stops the music within a second" is an acceptance test, not a nicety.

const z32 = require('z32')

// Pure. No Hyperbee, no clock of its own, no I/O - so every branch is trivially
// unit-testable and there is no excuse for an untested one.
//
// Returns { allow: bool, reason: string }. `reason` is for the host log and the
// dashboard; it is never sent to the peer, because telling an attacker WHY they
// were refused is free intelligence.
function decide ({ grant, person }, now = Date.now()) {
  if (!grant) return { allow: false, reason: 'no-grant' }
  if (grant.revokedAt) return { allow: false, reason: 'device-revoked' }
  if (grant.expiresAt && now > grant.expiresAt) return { allow: false, reason: 'grant-expired' }
  if (person && person.revokedAt) return { allow: false, reason: 'person-revoked' }
  return { allow: true, reason: 'ok' }
}

// WHICH REFUSALS MAY BE EXPLAINED TO THE PEER, and it is a short list on purpose.
//
// `decide()`'s reason is never sent to a peer, because telling an attacker why it was
// refused is free intelligence. That rule is right for a STRANGER and wrong for
// somebody this host once let in: a device holding a tombstoned grant has already
// proved possession of a key this host granted, so it knows the library exists, knows
// it had access and holds the host key. There is nothing left to leak by saying "not
// any more" (proposal 2026-08-31-grant-fixes-trio, ported from PearCinema's
// 2026-08-22-say-goodbye-to-a-revoked-device).
//
// `no-grant` is deliberately NOT on this list. An unknown key learns nothing, exactly
// as before, and cannot use this path to make a host talk.
const FAREWELL_REASONS = new Set(['device-revoked', 'person-revoked', 'grant-expired'])

function mayBeToldWhy (reason) {
  return FAREWELL_REASONS.has(reason)
}

// One goodbye per key per interval, in a book that cannot grow without bound - a peer
// could otherwise mint keys and fill it. Pure of I/O (the caller passes `now`), so the
// rate limit is unit-testable without a server or a clock.
class FarewellBook {
  constructor ({ everyMs = 60_000, capacity = 256 } = {}) {
    this.everyMs = everyMs
    this.capacity = capacity
    this.at = new Map() // z32 deviceKey -> when the last goodbye was granted
  }

  // May this key be told right now? Saying yes RECORDS the goodbye, so asking is
  // spending - the caller must actually deliver it.
  shouldSay (key, now = Date.now()) {
    const last = this.at.get(key) || 0
    if (now - last < this.everyMs) return false
    if (this.at.size >= this.capacity && !this.at.has(key)) {
      const oldest = this.at.keys().next().value
      this.at.delete(oldest)
    }
    this.at.delete(key) // re-insert so Map order stays oldest-first
    this.at.set(key, now)
    return true
  }
}

// Which of the currently-LIVE devices should be cut right now? Pure, so the sweep's
// selection is unit-testable without a DHT or a clock. `lookups` maps deviceKey ->
// { grant, person }; the caller (the host) loads them, then kills what this returns.
//
// This exists for TIME-BASED expiry: `decide()` runs only at connect, so a guest that
// connected before its grant expired would stream on until it reconnected - the same gap
// `Connections` closes for revoke. Revoke fires an event we hang kill() on; an expiry has
// none, so the host sweeps periodically and kills whatever decide() now refuses.
function sweepKills (liveKeys, lookups, now = Date.now()) {
  return liveKeys.filter(k => !decide(lookups.get(k) || { grant: null }, now).allow)
}

// May a device pairing again INHERIT the person it held before? Pure, so the one rule
// that decides it is unit-testable on its own (proposal 2026-07-21-person-carryover-on-repair).
//
// `existing` is the tombstoned grant for this same Noise-authenticated key; `person` is the
// row its personId points at, loaded by the caller (null if it has been deleted).
//
// Restores ONLY a departure the device made itself. An operator revoke - or a revoked person,
// or a person deleted while the device was away - starts it as a stranger with a pending
// claim, because that checkpoint is the entire point of revoke. Tombstones written before
// `revokedBy` existed have it undefined, which is not 'self', so nothing already on disk
// changes behaviour.
function carryOverPerson (existing, person) {
  if (!existing || !existing.revokedAt) return null
  if (existing.revokedBy !== 'self') return null
  if (!existing.personId) return null
  if (!person || person.revokedAt) return null
  if (person.id !== existing.personId) return null
  return existing.personId
}

// Registry of live connections, keyed by the peer's Noise-proven public key.
class Connections {
  constructor () {
    this.byDevice = new Map() // z32 deviceKey -> Set<connection>
  }

  add (deviceKey, conn) {
    const key = typeof deviceKey === 'string' ? deviceKey : z32.encode(deviceKey)
    let set = this.byDevice.get(key)
    if (!set) {
      set = new Set()
      this.byDevice.set(key, set)
    }
    set.add(conn)
    conn.once('close', () => this.remove(key, conn))
    return key
  }

  remove (deviceKey, conn) {
    const key = typeof deviceKey === 'string' ? deviceKey : z32.encode(deviceKey)
    const set = this.byDevice.get(key)
    if (!set) return
    set.delete(conn)
    if (set.size === 0) this.byDevice.delete(key)
  }

  count (deviceKey) {
    const key = typeof deviceKey === 'string' ? deviceKey : z32.encode(deviceKey)
    return this.byDevice.get(key)?.size ?? 0
  }

  // The z32 device keys that currently hold at least one live connection - what the
  // expiry sweep walks.
  deviceKeys () {
    return [...this.byDevice.keys()]
  }

  // The teeth. Destroy every live connection for a device.
  //
  // `destroy()` rather than `end()`: end() is a graceful half-close that lets
  // buffered audio keep flowing, which would let a revoked device finish the
  // song. Revocation should be abrupt.
  kill (deviceKey) {
    const key = typeof deviceKey === 'string' ? deviceKey : z32.encode(deviceKey)
    const set = this.byDevice.get(key)
    if (!set) return 0
    let n = 0
    for (const conn of [...set]) {
      try {
        conn.destroy()
        n++
      } catch {
        // already gone; the close handler will have cleaned up
      }
    }
    this.byDevice.delete(key)
    return n
  }

  killAll (deviceKeys) {
    let n = 0
    for (const k of deviceKeys) n += this.kill(k)
    return n
  }

  get size () {
    let n = 0
    for (const set of this.byDevice.values()) n += set.size
    return n
  }
}

module.exports = { decide, mayBeToldWhy, FarewellBook, sweepKills, carryOverPerson, Connections }
