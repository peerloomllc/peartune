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
// Favorites are per KIND - a track, an album, or an artist - because that is what
// people expect (Apple Music favorites all three; Subsonic `star` and Jellyfin
// IsFavorite both apply to any of them).
//
// Rows (Tier 1, library-scoped - see the proposal's tiering):
//   fav:{ownerId}:{kind}:{id} -> { kind, id, on, updatedAt }
//
// ownerId is `p:{personId}` for a device assigned to a person, else `d:{deviceKey}` for
// an unclaimed device (it is its own owner until the operator confirms a claim). The id
// is our source-scoped trackId for a track, or the adapter's album/artist id.
//
// NOTE: milestone-3-phase-1 stored track favorites as `fav:{ownerId}:{trackId}` (no
// kind segment). Those legacy rows do not match a `fav:{ownerId}:{kind}:` scan and are
// simply ignored - a clean break, acceptable because favorites only ever held a day of
// test data. Nothing migrates.

const FAV_KINDS = ['track', 'album', 'artist']

class UserState {
  constructor (bee) {
    this.bee = bee
  }

  _favKey (ownerId, kind, id) {
    return `fav:${ownerId}:${kind}:${id}`
  }

  // Toggle a favorite. The host stamps `updatedAt`; an un-favorite (on:false) is kept
  // as an explicit row rather than deleted, so "off" is durable and a later stale read
  // cannot resurrect it.
  async setFav (ownerId, kind, id, on) {
    if (!FAV_KINDS.includes(kind)) throw new Error('bad favorite kind: ' + kind)
    const row = { kind, id, on: !!on, updatedAt: Date.now() }
    await this.bee.put(this._favKey(ownerId, kind, id), row, { valueEncoding: 'json' })
    return row
  }

  async getFav (ownerId, kind, id) {
    const node = await this.bee.get(this._favKey(ownerId, kind, id), { valueEncoding: 'json' })
    return node ? node.value : null
  }

  // --- resume positions (milestone 3, phase 2) ------------------------------
  //
  // resume:{ownerId}:{trackId} -> { trackId, positionMs, durationMs, updatedAt }.
  // Same host-as-hub deal: the host stamps updatedAt, the owner comes from the
  // connection, and cross-device "pick up where you left off" is free because a
  // person's devices share the store. A position of 0 (or less) is not stored - it is a
  // DELETE, so finishing a track leaves no row and it starts fresh next time.
  async setResume (ownerId, trackId, positionMs, durationMs) {
    const key = `resume:${ownerId}:${trackId}`
    if (!(positionMs > 0)) {
      await this.bee.del(key)
      return null
    }
    const row = { trackId, positionMs, durationMs: durationMs || null, updatedAt: Date.now() }
    await this.bee.put(key, row, { valueEncoding: 'json' })
    return row
  }

  async getResume (ownerId, trackId) {
    const node = await this.bee.get(`resume:${ownerId}:${trackId}`, { valueEncoding: 'json' })
    return node ? node.value : null
  }

  // The owner's MOST RECENT resume - the "continue listening" candidate. Null if none.
  async latestResume (ownerId) {
    const lo = `resume:${ownerId}:`
    const hi = `resume:${ownerId};`
    let best = null
    for await (const node of this.bee.createReadStream({ gte: lo, lt: hi }, { valueEncoding: 'json' })) {
      const v = node.value
      if (v && v.positionMs > 0 && (!best || v.updatedAt > best.updatedAt)) best = v
    }
    return best
  }

  // The owner's favorites, grouped by kind: { track:[ids], album:[ids], artist:[ids] }.
  // One prefix scan per kind. Every `fav:{ownerId}:{kind}:{id}` key sorts below
  // `fav:{ownerId}:{kind};` (';' is ':'+1, and a z32 id never contains ':' or ';'), so
  // the range is exact - the same trick the grant store uses (host/grants.js).
  async listFavs (ownerId) {
    const out = { track: [], album: [], artist: [] }
    for (const kind of FAV_KINDS) {
      const lo = `fav:${ownerId}:${kind}:`
      const hi = `fav:${ownerId}:${kind};`
      for await (const node of this.bee.createReadStream({ gte: lo, lt: hi }, { valueEncoding: 'json' })) {
        if (node.value && node.value.on) out[kind].push(node.value.id)
      }
    }
    return out
  }
}

module.exports = { UserState, FAV_KINDS }
