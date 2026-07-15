// User state: the per-person music state the HOST holds and serves.
//
// Milestone 3 uses HOST-AS-HUB, not an Autobase ledger (proposal
// 2026-07-15-milestone-3-user-state, which SUPERSEDES the 2026-07-13 "host is a full
// Autobase writer" decision). PearTune is the one PeerLoom app with an always-on host,
// so the host simply stores each person's favorites (then resume positions, play
// counts, playlists) and serves them back - and cross-device sync is free, because a
// person's devices all talk to the same host.
//
// The forgery-proofing is the same shape as the grant store: the OWNER is derived by
// the host from the Noise-authenticated connection (see host/media.js `ownerOf`), never
// sent by the client. There is ONE writer - the host - so there is no cross-writer
// threat and no conflict resolution to get wrong; the host stamps `updatedAt` itself, so
// a client cannot backdate a write.
//
// Rows (Tier 1, library-scoped - see the proposal's tiering):
//   fav:{ownerId}:{trackId} -> { trackId, on, updatedAt }
//
// ownerId is `p:{personId}` for a device assigned to a person, else `d:{deviceKey}` for
// an unclaimed device (it is its own owner until the operator confirms a claim).

class UserState {
  constructor (bee) {
    this.bee = bee
  }

  _favKey (ownerId, trackId) {
    return `fav:${ownerId}:${trackId}`
  }

  // Toggle a favorite. The host stamps `updatedAt`; an un-favorite (on:false) is kept
  // as an explicit row rather than deleted, so "off" is durable and a later stale read
  // cannot resurrect it.
  async setFav (ownerId, trackId, on) {
    const row = { trackId, on: !!on, updatedAt: Date.now() }
    await this.bee.put(this._favKey(ownerId, trackId), row, { valueEncoding: 'json' })
    return row
  }

  async getFav (ownerId, trackId) {
    const node = await this.bee.get(this._favKey(ownerId, trackId), { valueEncoding: 'json' })
    return node ? node.value : null
  }

  // The owner's currently-favorited trackIds. Prefix scan: every
  // `fav:{ownerId}:{trackId}` key sorts below `fav:{ownerId};` (';' is ':'+1, and a
  // z32 ownerId/trackId never contains ':' or ';'), so the range is exact. Same trick
  // the grant store uses (host/grants.js).
  async listFavs (ownerId) {
    const lo = `fav:${ownerId}:`
    const hi = `fav:${ownerId};`
    const out = []
    for await (const node of this.bee.createReadStream({ gte: lo, lt: hi }, { valueEncoding: 'json' })) {
      if (node.value && node.value.on) out.push(node.value.trackId)
    }
    return out
  }
}

module.exports = { UserState }
