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

const crypto = require('crypto')

const FAV_KINDS = ['track', 'album', 'artist']

const PLAYLIST_NAME_MAX = 100
const PLAYLIST_MAX_TRACKS = 10000

// The play session (cross-device handoff, proposal 2026-07-17) mirrors the app's queue
// verbatim, so it is capped the same way. Each item is { trackId, ...renderMeta } - IDs +
// what the receiver needs to render + re-resolve, never shim URLs (ports change per launch).
const SESSION_MAX_TRACKS = 10000
function sanitizeQueue (q) {
  if (!Array.isArray(q)) return []
  return q.filter(t => t && typeof t.trackId === 'string' && t.trackId).slice(0, SESSION_MAX_TRACKS)
}

// Playlist names are operator-and-user text that renders on the phone (and could reach
// the dashboard later), so strip control chars and cap the length here at the single
// writer, exactly like device/user names (proposal 2026-07-14). An empty name is not an
// error - it becomes a sensible default rather than an untitled blank row.
function sanitizePlaylistName (name) {
  const s = String(name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, PLAYLIST_NAME_MAX)
  return s || 'Untitled playlist'
}

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

  // --- play counts (milestone 3, phase 3) -----------------------------------
  //
  // count:{ownerId}:{trackId} -> { trackId, count, updatedAt }. Host-as-hub, so the
  // host is the single writer and just reads-modifies-writes the integer - no
  // per-writer accounting (that was only needed for the ledger design we did NOT take;
  // see DECISIONS). Counts survive revoke by design (they are history, not access).
  async bumpCount (ownerId, trackId) {
    const key = `count:${ownerId}:${trackId}`
    const node = await this.bee.get(key, { valueEncoding: 'json' })
    const count = (node?.value?.count || 0) + 1
    await this.bee.put(key, { trackId, count, updatedAt: Date.now() }, { valueEncoding: 'json' })
    return count
  }

  async getCount (ownerId, trackId) {
    const node = await this.bee.get(`count:${ownerId}:${trackId}`, { valueEncoding: 'json' })
    return node?.value?.count || 0
  }

  // The owner's most-played trackIds, [{ trackId, count }] descending.
  async topCounts (ownerId, limit = 50) {
    const lo = `count:${ownerId}:`
    const hi = `count:${ownerId};`
    const rows = []
    for await (const node of this.bee.createReadStream({ gte: lo, lt: hi }, { valueEncoding: 'json' })) {
      if (node.value?.count > 0) rows.push({ trackId: node.value.trackId, count: node.value.count })
    }
    rows.sort((a, b) => b.count - a.count)
    return rows.slice(0, limit)
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

  // --- playlists (milestone 3, phase 4) -------------------------------------
  //
  // OUR playlists, host-owned (host-as-hub). A playlist is one row holding its
  // ordered trackIds inline:
  //   playlist:{ownerId}:{playlistId} -> { id, name, trackIds:[...], createdAt, updatedAt }
  //
  // A plain ordered array is enough BECAUSE the host is the single writer - the
  // fractional-index / CRDT machinery a ledger would need (the milestone-3 proposal
  // calls this out) is a multi-writer problem we do not have. Reorder and remove are
  // just a rewrite of the array. The playlistId is minted by the host (never by the
  // client), so it cannot collide with or overwrite another owner's playlist; and
  // because the key carries the host-derived ownerId, a client can only ever reach
  // its own playlists even if it guesses another's id. These are TIER 1 (this one
  // library's tracks); cross-library playlists are the deferred Tier 2.
  _plKey (ownerId, id) {
    return `playlist:${ownerId}:${id}`
  }

  async createPlaylist (ownerId, name) {
    const id = crypto.randomBytes(9).toString('hex')
    const now = Date.now()
    const row = { id, name: sanitizePlaylistName(name), trackIds: [], createdAt: now, updatedAt: now }
    await this.bee.put(this._plKey(ownerId, id), row, { valueEncoding: 'json' })
    return row
  }

  async getPlaylist (ownerId, id) {
    const node = await this.bee.get(this._plKey(ownerId, id), { valueEncoding: 'json' })
    return node ? node.value : null
  }

  // Summaries only ({ id, name, count, updatedAt }) - the list view does not need
  // every trackId, and a person with big playlists should not ship them all to render
  // a menu. Most-recently-touched first.
  async listPlaylists (ownerId) {
    const lo = `playlist:${ownerId}:`
    const hi = `playlist:${ownerId};`
    const rows = []
    for await (const node of this.bee.createReadStream({ gte: lo, lt: hi }, { valueEncoding: 'json' })) {
      const v = node.value
      if (v) rows.push({ id: v.id, name: v.name, count: (v.trackIds || []).length, updatedAt: v.updatedAt })
    }
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return rows
  }

  // The mutations below read-modify-write the one row. They return the updated row, or
  // NULL when no such playlist exists for this owner - which is also the ownership
  // check: the key is built from the host-derived ownerId, so another owner's id
  // simply misses. (Single writer + single-threaded host, so no lock; this is the same
  // read-modify-write shape as bumpCount.)
  async renamePlaylist (ownerId, id, name) {
    const row = await this.getPlaylist(ownerId, id)
    if (!row) return null
    row.name = sanitizePlaylistName(name)
    row.updatedAt = Date.now()
    await this.bee.put(this._plKey(ownerId, id), row, { valueEncoding: 'json' })
    return row
  }

  async deletePlaylist (ownerId, id) {
    await this.bee.del(this._plKey(ownerId, id))
    return { id }
  }

  // Append, but a playlist holds each track at most ONCE: a track already in the list
  // is skipped, and the incoming batch is de-duped too - so adding a song that is
  // already there never creates a duplicate or bumps the count (adding an album you
  // half-have just tops up the missing tracks). Removal is by position via
  // setPlaylistTracks.
  async addToPlaylist (ownerId, id, trackIds) {
    const row = await this.getPlaylist(ownerId, id)
    if (!row) return null
    const seen = new Set(row.trackIds || [])
    const add = []
    for (const x of (Array.isArray(trackIds) ? trackIds : [])) {
      if (typeof x === 'string' && x && !seen.has(x)) { seen.add(x); add.push(x) }
    }
    row.trackIds = [...(row.trackIds || []), ...add].slice(0, PLAYLIST_MAX_TRACKS)
    row.updatedAt = Date.now()
    await this.bee.put(this._plKey(ownerId, id), row, { valueEncoding: 'json' })
    return row
  }

  // Replace the whole ordered list - this is how the app does BOTH reorder and remove
  // (it sends the new order), so there is one write path to reason about instead of
  // fiddly move/remove-at-index handlers.
  async setPlaylistTracks (ownerId, id, trackIds) {
    const row = await this.getPlaylist(ownerId, id)
    if (!row) return null
    row.trackIds = (Array.isArray(trackIds) ? trackIds : []).filter(x => typeof x === 'string' && x).slice(0, PLAYLIST_MAX_TRACKS)
    row.updatedAt = Date.now()
    await this.bee.put(this._plKey(ownerId, id), row, { valueEncoding: 'json' })
    return row
  }

  // --- play session: cross-device handoff (proposal 2026-07-17) --------------
  //
  // ONE row per owner - the person's current listening session:
  //   session:{ownerId} -> { queue:[{trackId,...meta}], index, shuffle, repeat,
  //                          positionMs, playing, activeDeviceKey, generation, updatedAt }
  //
  // This is SESSION state, not library state, so it is NOT ambient last-write-wins like
  // favorites. A single active device holds the session via `activeDeviceKey`, and taking it
  // is a deliberate act guarded by a monotonic `generation` compare-and-set (the conflict
  // primitive). `activeDeviceKey` is the specific DEVICE key (not the owner), because two of
  // a person's devices share the ownerId but only one is active.
  //
  // POSITION rides here now, not only the resume row. The active device carries positionMs in
  // the SAME throttled heartbeat that already mirrors the queue (no new write cadence - the
  // heartbeat fires anyway), so "Play here" seeks to the queue and the position ATOMICALLY,
  // with no extra round-trip and no read-after-write race against resume (deferred follow-up
  // #3, chosen over the proposal's losing-device flush - which a backgrounded loser cannot
  // do). `playing` says whether the active device is playing or paused, so another device's
  // card can read "Paused on X" honestly instead of "Playing on X" (follow-up #2).
  // `merged` selects the CROSS-HOST session (multi-host phase 3, proposal 2026-07-20): a distinct
  // row so a host can be BOTH someone's single-library session home and the elected merged home
  // without collision. The queue then carries foreign trackIds from other hosts, which we store
  // opaquely - they are metadata to us, we never dereference them.
  _sessionKey (ownerId, merged) {
    return merged ? `session:merged:${ownerId}` : `session:${ownerId}`
  }

  async getSession (ownerId, merged = false) {
    const node = await this.bee.get(this._sessionKey(ownerId, merged), { valueEncoding: 'json' })
    return node ? node.value : null
  }

  // Take the active-player token via compare-and-set. The caller passes the `generation` it
  // last saw; if it still matches (nobody claimed since), we bump it, stamp this device active,
  // and return the new row. A stale generation returns null - the caller lost the race and must
  // re-read. A missing row is generation 0, so the first claimer creates it. A claim ADOPTS the
  // existing queue (it does not wipe it) - "Play here" continues the session, it does not clear it.
  async claimSession (ownerId, deviceKey, generation = 0, merged = false) {
    const row = await this.getSession(ownerId, merged)
    const cur = row?.generation || 0
    if ((Number(generation) || 0) !== cur) return null // someone else holds/changed it
    const next = {
      queue: row?.queue || [],
      index: row?.index || 0,
      shuffle: row?.shuffle || false,
      repeat: row?.repeat || 0,
      // Adopt the leaving device's last-known position, so "Play here" can seek immediately
      // from the claim's own reply (the receiver need not chase a separate resume read).
      positionMs: row?.positionMs || 0,
      playing: row?.playing || false,
      activeDeviceKey: deviceKey,
      generation: cur + 1,
      updatedAt: Date.now()
    }
    await this.bee.put(this._sessionKey(ownerId, merged), next, { valueEncoding: 'json' })
    return next
  }

  // Replace the session's queue/index/modes. ONLY the current active device may do this; a
  // non-holder (a device superseded by a claim it has not noticed yet) is rejected with null,
  // which is exactly how it learns it is no longer active (lazy presence). The token
  // (activeDeviceKey + generation) is left untouched.
  async setSession (ownerId, deviceKey, { queue, index, shuffle, repeat, positionMs, playing } = {}, merged = false) {
    const row = await this.getSession(ownerId, merged)
    if (!row || row.activeDeviceKey !== deviceKey) return null
    row.queue = sanitizeQueue(queue)
    row.index = Number.isInteger(index) && index >= 0 ? index : 0
    row.shuffle = !!shuffle
    row.repeat = Number(repeat) || 0
    // Position + playing ride the same heartbeat as the queue (see the header note). Clamp to
    // a non-negative integer; a garbage value just means the receiver seeks to 0, never throws.
    row.positionMs = Number.isFinite(positionMs) && positionMs > 0 ? Math.round(positionMs) : 0
    row.playing = !!playing
    row.updatedAt = Date.now()
    await this.bee.put(this._sessionKey(ownerId, merged), row, { valueEncoding: 'json' })
    return row
  }

  // --- purge one owner ------------------------------------------------------
  //
  // Remove EVERY row this owner holds: favorites, resume points, play counts,
  // playlists and both session rows. The operator deleting a person is the only
  // caller (host/server.js). Without it "Delete Ben" left Ben's listening history
  // in the store forever, unreachable but present - a slow leak AND a privacy wart,
  // since the button plainly says delete.
  //
  // Scoped by the same `:` .. `;` bound trick listFavs uses, so owner `p:abc` never
  // reaches `p:abcd` ('d' sorts above ';'). Keys are collected before deleting rather
  // than deleted mid-stream. Returns how many rows went.
  async deleteOwner (ownerId) {
    const keys = []
    for (const prefix of ['fav', 'resume', 'count', 'playlist']) {
      const lo = `${prefix}:${ownerId}:`
      const hi = `${prefix}:${ownerId};`
      for await (const node of this.bee.createReadStream({ gte: lo, lt: hi })) keys.push(node.key)
    }
    for (const key of [this._sessionKey(ownerId, false), this._sessionKey(ownerId, true)]) {
      if (await this.bee.get(key)) keys.push(key)
    }
    for (const key of keys) await this.bee.del(key)
    return keys.length
  }
}

module.exports = { UserState, FAV_KINDS }
