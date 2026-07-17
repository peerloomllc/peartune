// Presence: the host's registry of live media-channel push senders, keyed by device.
//
// The media API is otherwise pure request/response - the client asks, the host answers.
// One feature needs the host to speak first: cross-device session handoff. When device B
// claims the play-session token, the device that HELD it (A) must be told at once so it
// stops, instead of finding out lazily on its next heartbeat (proposal 2026-07-17,
// deferred follow-up #1). But B's claim runs on B's connection, and A is a DIFFERENT
// connection - so the host needs a way to reach A's channel from B's request. That is all
// this is: a shared map so any connection's handler can push to another device's channel.
//
// SECURITY. This adds NO access surface. A push only rides a channel that already exists,
// which only exists on a connection the firewall already admitted; register() is called
// from serveMedia AFTER the grant check. Revoke destroys the connection, whose channel
// close unregisters here, so a revoked device is gone from the registry and cannot be
// pushed to. The registry keys by the same z32 deviceKey string the grant carries.

const z32 = require('z32')

function keyOf (deviceKey) {
  return typeof deviceKey === 'string' ? deviceKey : z32.encode(deviceKey)
}

class Presence {
  constructor () {
    // deviceKey (z32 string) -> Set<pushFn>. A Set because one device may hold more than
    // one live connection (a reconnect can briefly overlap the old one); push to all of them.
    this._byDevice = new Map()
  }

  // Register a live channel's push sender. Returns an unregister function the caller MUST
  // call on channel close, or a dead sender lingers and a later notify() throws into the void.
  register (deviceKey, pushFn) {
    const key = keyOf(deviceKey)
    let set = this._byDevice.get(key)
    if (!set) { set = new Set(); this._byDevice.set(key, set) }
    set.add(pushFn)
    return () => {
      const s = this._byDevice.get(key)
      if (!s) return
      s.delete(pushFn)
      if (s.size === 0) this._byDevice.delete(key)
    }
  }

  // Send a typed event to every live connection of one device. Returns how many received it.
  // A throwing sender (a channel that closed a tick ago) is swallowed - one bad connection
  // must not stop the others, and the close handler will unregister it imminently anyway.
  notify (deviceKey, kind, data = null) {
    const set = this._byDevice.get(keyOf(deviceKey))
    if (!set) return 0
    let n = 0
    for (const pushFn of set) {
      try { pushFn({ kind, data }); n++ } catch {}
    }
    return n
  }

  // Live connection count for a device (test/introspection).
  count (deviceKey) {
    return this._byDevice.get(keyOf(deviceKey))?.size || 0
  }
}

module.exports = { Presence }
