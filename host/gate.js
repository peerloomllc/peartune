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

module.exports = { decide, sweepKills, Connections }
