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
const { SCOPE } = require('../protocol/constants')

function keyOf (deviceKey) {
  return typeof deviceKey === 'string' ? deviceKey : z32.encode(deviceKey)
}

// Push to every device holding OWNER scope on this host - the operators, wherever they are signed
// in. The grant store is the authority on who that is (scope OWNER, not revoked); presence only
// reaches the ones with a live channel, and an owner who is offline picks the change up on their
// next load. Best-effort, like every push here.
//
// Factored out because there are now three callers and they must agree on who counts as an owner:
// a new request, a withdrawn one, and a resolved one. The first had this loop inline, and the
// other two had NOTHING - which is why an owner watching Manage saw a request arrive but never saw
// it leave (Tim, 2026-07-30).
async function notifyOwners (presence, grants, kind, data = null) {
  if (!presence || !grants) return 0
  let n = 0
  for (const g of await grants.list().catch(() => [])) {
    if (g.scope !== SCOPE.OWNER || g.revokedAt) continue
    n += presence.notify(g.deviceKey, kind, data)
  }
  return n
}

class Presence {
  constructor () {
    // deviceKey (z32 string) -> Set<pushFn>. A Set because one device may hold more than
    // one live connection (a reconnect can briefly overlap the old one); push to all of them.
    this._byDevice = new Map()
    // ownerId (the host-derived "p:<person>" / "d:<device>" a person's state is stored under)
    // -> Set<pushFn>. Lets a push reach a PERSON across all their devices (a request:resolved
    // to whoever asked), where _byDevice reaches one specific device (a session handoff).
    this._byOwner = new Map()
  }

  // Register a live channel's push sender. Returns an unregister function the caller MUST
  // call on channel close, or a dead sender lingers and a later notify() throws into the void.
  // ownerId is optional so the handoff callers that only key by device still work unchanged;
  // pass it to make the channel reachable by notifyOwner too.
  register (deviceKey, pushFn, ownerId = null) {
    const key = keyOf(deviceKey)
    let set = this._byDevice.get(key)
    if (!set) { set = new Set(); this._byDevice.set(key, set) }
    set.add(pushFn)
    let oset = null
    let entry = null
    if (ownerId) {
      oset = this._byOwner.get(ownerId)
      if (!oset) { oset = new Set(); this._byOwner.set(ownerId, oset) }
      // The owner set holds { deviceKey, fn }, not a bare fn, so a push to a PERSON can skip the
      // device that caused it - "your favorites changed" is news to your other phones and not to
      // the one you just tapped, which already re-rendered optimistically.
      entry = { deviceKey: key, fn: pushFn }
      oset.add(entry)
    }
    return () => {
      const s = this._byDevice.get(key)
      if (s) { s.delete(pushFn); if (s.size === 0) this._byDevice.delete(key) }
      if (oset && entry) { oset.delete(entry); if (oset.size === 0) this._byOwner.delete(ownerId) }
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

  // Send a typed event to every live connection of one PERSON (all their devices), keyed by the
  // ownerId their state is stored under. Best-effort, same swallow-a-bad-sender contract as notify.
  // Used to tell whoever filed a request that it was resolved, wherever they are signed in.
  //
  // `exceptDevice` skips one device's connections - for a change that device MADE, where the news
  // is only news to the person's other phones. Omit it and every device hears, which is what the
  // request:resolved caller wants (it did not make the change; the operator did).
  notifyOwner (ownerId, kind, data = null, { exceptDevice = null } = {}) {
    const set = this._byOwner.get(ownerId)
    if (!set) return 0
    const skip = exceptDevice ? keyOf(exceptDevice) : null
    let n = 0
    for (const entry of set) {
      if (skip && entry.deviceKey === skip) continue
      try { entry.fn({ kind, data }); n++ } catch {}
    }
    return n
  }

  // Broadcast a typed event to EVERY live connection of EVERY device. Returns how many received
  // it. For host-wide changes that aren't aimed at one device - a library rename, so every paired
  // phone relabels at once. Same swallow-a-bad-sender contract as notify(): one dead channel must
  // not stop the rest, and its close handler unregisters it imminently.
  notifyAll (kind, data = null) {
    let n = 0
    for (const set of this._byDevice.values()) {
      for (const pushFn of set) {
        try { pushFn({ kind, data }); n++ } catch {}
      }
    }
    return n
  }

  // Live connection count for a device (test/introspection).
  count (deviceKey) {
    return this._byDevice.get(keyOf(deviceKey))?.size || 0
  }
}

module.exports = { Presence, notifyOwners }
