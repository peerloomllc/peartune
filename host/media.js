// Host side of peartune/media/1.
//
// We do NOT tunnel a raw port (DECISIONS 2026-07-13). A tunnel would hand a
// guest Navidrome's entire surface plus its credentials, make per-request scope
// enforcement impossible, and teach the app to speak Subsonic - which would
// quietly demote the raw-folder adapter to a second-class citizen. Instead the
// host answers a normalized API, and the two source adapters sit behind it.

const Protomux = require('protomux')
const b4a = require('b4a')
const { mediaChannel } = require('../protocol/channels')
const { CHUNK_SIZE, ERR, SCOPE } = require('../protocol/constants')

// Methods that mutate. A readonly grant is refused HERE rather than at the adapter,
// so a new mutating method cannot accidentally ship without a scope check.
const MUTATING = new Set([
  'identity.set', 'identity.avatar', 'fav.set', 'resume.set', 'count.bump',
  'playlist.create', 'playlist.rename', 'playlist.delete', 'playlist.add', 'playlist.setTracks',
  'session.claim', 'session.set'
])

// WHO owns the user state on this connection. Derived from the grant the firewall
// looked up from the Noise-authenticated remote key - NEVER from a client parameter,
// which is the whole reason host-as-hub is safe (there is nothing to forge). A device
// assigned to a person owns state as that person (so their phone + tablet share it);
// an unclaimed device is its own owner until the operator confirms a claim.
function ownerOf (grant) {
  return grant.personId ? 'p:' + grant.personId : 'd:' + grant.deviceKey
}

function serveMedia ({ conn, libraryId, getAdapter, libraryName = null, grant, grants = null, state = null, presence = null, avatars = null, log = () => {} }) {
  const mux = Protomux.from(conn)

  // Set once the channel is open (below). Called on close to drop this connection's push
  // sender from the presence registry, so a dead channel is never pushed to.
  let unregisterPresence = () => {}

  // Registration order is fixed in protocol/channels.js and MUST match the
  // client's. Do not hand-roll addMessage here - see the note in that file.
  const built = mediaChannel(mux, {
    id: b4a.from(libraryId),
    onclose: () => { unregisterPresence(); log('media:channel-closed') },
    onreq: async (m) => {
      try {
        await dispatch(m)
      } catch (e) {
        log('media:dispatch-failed', { method: m?.method, err: e?.message })
        safeErr(m?.id ?? 0, ERR.INTERNAL, 'internal error')
      }
    }
  })

  if (!built) return null

  const { channel } = built
  const send = built.messages

  channel.open()

  // This connection is now reachable by an unsolicited push. Keyed by the grant's device -
  // the one the firewall authenticated - so a session.claim on ANOTHER connection can reach it.
  if (presence) unregisterPresence = presence.register(grant.deviceKey, (evt) => { try { send.push.send(evt) } catch {} })

  function safeErr (id, code, message) {
    try {
      send.err.send({ id, code, message })
    } catch {}
  }

  // Backpressure. Protomux `send()` returns false when the underlying stream is
  // full; pushing a whole album through regardless would balloon memory on a
  // Pi-class host. Wait for drain before the next frame.
  function drain () {
    return new Promise(resolve => conn.once('drain', resolve))
  }

  async function pipeStream (id, stream) {
    let seq = 0
    let total = 0
    try {
      for await (const buf of stream) {
        // Frames are capped so a seek is never stuck behind one fat in-flight
        // chunk, regardless of what the source hands us.
        for (let off = 0; off < buf.length; off += CHUNK_SIZE) {
          const slice = buf.subarray(off, Math.min(off + CHUNK_SIZE, buf.length))
          const ok = send.chunk.send({ id, seq: seq++, data: slice })
          total += slice.length
          if (!ok) await drain()
          if (channel.closed) return
        }
      }
      send.end.send({ id, total })
    } catch (e) {
      log('media:stream-failed', { id, err: e?.message })
      safeErr(id, ERR.INTERNAL, 'stream failed')
    }
  }

  // CONFIRMED means the claim matches the person this device is actually assigned
  // to - not merely that SOME person is assigned.
  //
  // Otherwise, changing your name after being confirmed leaves the app saying
  // "confirmed as Tim" while the row claims something else entirely. A rename is a
  // NEW claim, and it is pending until the operator says otherwise. (The device
  // still cannot move itself: only the operator confirms. That part is the point.)
  async function identityOf (row) {
    const person = row?.personId && grants ? await grants.getPerson(row.personId) : null
    const claim = row?.claimedUser || null
    return {
      deviceName: row?.label || null,
      belongsTo: person ? person.name : null,
      // The library's CURRENT name (a getter, read now), so a dashboard rename reflects on the
      // phone on its next connect - the app updates its stored host record + UI from this.
      libraryName: libraryName ? libraryName() : null,
      // The device's own guest expiry (null = permanent), so the phone can show a
      // "guest access expires in X" banner. Read from THIS connection's grant, never a
      // param - a device only ever learns its OWN access. Refreshed on every connect, so
      // an operator extending or clearing it on the dashboard reflects on the phone.
      expiresAt: row?.expiresAt ?? null,
      user: claim
        ? {
            name: claim,
            confirmed: !!person && person.name.toLowerCase() === claim.toLowerCase()
          }
        : null
    }
  }

  async function dispatch (m) {
    const { id, method, params } = m

    if (MUTATING.has(method) && grant?.scope === SCOPE.READONLY) {
      return safeErr(id, ERR.FORBIDDEN, 'read-only grant')
    }

    switch (method) {
      case 'ping':
        return send.res.send({ id, body: { protocol: 1, libraryId } })

      case 'library.stats':
        return send.res.send({ id, body: await getAdapter().stats() })

      case 'library.list':
        return send.res.send({ id, body: await getAdapter().list(params || {}) })

      case 'library.get':
        return send.res.send({ id, body: await getAdapter().get(params || {}) })

      case 'library.search':
        return send.res.send({ id, body: await getAdapter().search(params || {}) })

      // --- identity (proposal 2026-07-14) ------------------------------------
      //
      // THE CALLER IS THE CONNECTION. `grant` here is the row the firewall already
      // looked up from the Noise-authenticated remote public key, so a device can
      // only ever read and write ITS OWN identity - there is no deviceKey parameter
      // to forge, and adding one would be the whole vulnerability.
      case 'identity.get': {
        return send.res.send({ id, body: await identityOf(grant) })
      }

      case 'identity.set': {
        if (!grants || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')

        // params.deviceKey and params.personId are IGNORED, not merely unused: a
        // device names ITSELF, and only the operator decides who it belongs to.
        // A claim is cosmetic until confirmed on the dashboard.
        const row = await grants.setIdentity(grant.deviceKey, {
          deviceName: params?.deviceName,
          userName: params?.userName
        })
        if (!row) return safeErr(id, ERR.FORBIDDEN, 'no grant')

        log('identity:set', { label: row.label, claims: row.claimedUser || null })

        return send.res.send({ id, body: { ok: true, ...(await identityOf(row)) } })
      }

      // A device sets its OWN avatar: a small JPEG, base64 in params.avatar. Keyed by
      // grant.deviceKey (this connection's Noise-authenticated key), so a device can
      // only ever set its own photo. The bytes go to the file-backed avatar store, not
      // the grant bee. An empty/absent avatar clears it.
      case 'identity.avatar': {
        if (!grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!avatars) return safeErr(id, ERR.NOT_FOUND, 'avatars unavailable')
        try {
          const buf = params?.avatar ? Buffer.from(String(params.avatar), 'base64') : null
          if (!buf || !buf.length) avatars.delete(grant.deviceKey)
          else avatars.set(grant.deviceKey, buf)
        } catch (e) {
          return safeErr(id, ERR.BAD_PARAMS, e.message)
        }
        log('identity:avatar', { bytes: (params?.avatar || '').length })
        return send.res.send({ id, body: { ok: true } })
      }

      // --- user state: favorites (host-as-hub, milestone 3) ------------------
      //
      // The owner comes from THIS connection's grant (ownerOf), never from params -
      // same rule as identity.set. A device can only ever touch its own state.
      case 'fav.list': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        // Grouped { track:[ids], album:[ids], artist:[ids] }.
        return send.res.send({ id, body: await state.listFavs(ownerOf(grant)) })
      }

      case 'fav.set': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        // kind defaults to 'track', and id accepts the old `trackId` name, so a phase-1
        // app degrades cleanly. An unknown kind is a bad-params error, not a throw.
        const kind = params?.kind || 'track'
        const favId = params?.id || params?.trackId
        if (!favId) return safeErr(id, ERR.BAD_PARAMS, 'id required')
        let row
        try {
          row = await state.setFav(ownerOf(grant), kind, favId, params?.on !== false)
        } catch {
          return safeErr(id, ERR.BAD_PARAMS, 'bad favorite kind')
        }
        log('fav:set', { kind: row.kind, on: row.on })
        return send.res.send({ id, body: { ok: true, kind: row.kind, id: row.id, on: row.on } })
      }

      // --- play counts (milestone 3, phase 3) -------------------------------
      case 'count.bump': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!params?.trackId) return safeErr(id, ERR.BAD_PARAMS, 'trackId required')
        const count = await state.bumpCount(ownerOf(grant), params.trackId)
        log('count:bump', { count })
        return send.res.send({ id, body: { ok: true, count } })
      }

      case 'count.top': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        return send.res.send({ id, body: { items: await state.topCounts(ownerOf(grant), Number(params?.limit) || 50) } })
      }

      // --- resume positions (milestone 3, phase 2) --------------------------
      case 'resume.get': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!params?.trackId) return safeErr(id, ERR.BAD_PARAMS, 'trackId required')
        const row = await state.getResume(ownerOf(grant), params.trackId)
        log('resume:get', { positionMs: row?.positionMs || 0 })
        return send.res.send({ id, body: { positionMs: row?.positionMs || 0, durationMs: row?.durationMs || null } })
      }

      case 'resume.latest': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        const row = await state.latestResume(ownerOf(grant))
        // updatedAt lets the merged client pick the globally-newest resume across hosts.
        return send.res.send({ id, body: row ? { trackId: row.trackId, positionMs: row.positionMs, durationMs: row.durationMs, updatedAt: row.updatedAt || 0 } : null })
      }

      case 'resume.set': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!params?.trackId) return safeErr(id, ERR.BAD_PARAMS, 'trackId required')
        await state.setResume(ownerOf(grant), params.trackId, Number(params.positionMs) || 0, params.durationMs)
        log('resume:set', { positionMs: Number(params.positionMs) || 0 })
        return send.res.send({ id, body: { ok: true } })
      }

      // --- playlists (milestone 3, phase 4) ---------------------------------
      //
      // Host-owned "our" playlists. The owner comes from ownerOf(grant), never from
      // params - a device can only ever touch its own playlists, same rule as favorites
      // above. A mutation that names a playlist the owner does not have gets NOT_FOUND
      // (the state layer returns null), not a silent no-op.
      case 'playlist.list': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        return send.res.send({ id, body: { items: await state.listPlaylists(ownerOf(grant)) } })
      }

      case 'playlist.get': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!params?.id) return safeErr(id, ERR.BAD_PARAMS, 'id required')
        const row = await state.getPlaylist(ownerOf(grant), params.id)
        if (!row) return safeErr(id, ERR.NOT_FOUND, 'no such playlist')
        return send.res.send({ id, body: { id: row.id, name: row.name, trackIds: row.trackIds || [] } })
      }

      case 'playlist.create': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        const row = await state.createPlaylist(ownerOf(grant), params?.name)
        log('playlist:create', { id: row.id, name: row.name })
        return send.res.send({ id, body: { id: row.id, name: row.name } })
      }

      case 'playlist.rename': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!params?.id) return safeErr(id, ERR.BAD_PARAMS, 'id required')
        const row = await state.renamePlaylist(ownerOf(grant), params.id, params?.name)
        if (!row) return safeErr(id, ERR.NOT_FOUND, 'no such playlist')
        log('playlist:rename', { id: row.id, name: row.name })
        return send.res.send({ id, body: { id: row.id, name: row.name } })
      }

      case 'playlist.delete': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!params?.id) return safeErr(id, ERR.BAD_PARAMS, 'id required')
        await state.deletePlaylist(ownerOf(grant), params.id)
        log('playlist:delete', { id: params.id })
        return send.res.send({ id, body: { ok: true } })
      }

      case 'playlist.add': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!params?.id) return safeErr(id, ERR.BAD_PARAMS, 'id required')
        // How many actually landed, after de-duping against what is already there -
        // so the app can say "added 2" vs "already in the playlist" honestly.
        const before = (await state.getPlaylist(ownerOf(grant), params.id))?.trackIds?.length ?? 0
        const row = await state.addToPlaylist(ownerOf(grant), params.id, params?.trackIds)
        if (!row) return safeErr(id, ERR.NOT_FOUND, 'no such playlist')
        const added = row.trackIds.length - before
        log('playlist:add', { id: row.id, count: row.trackIds.length, added })
        return send.res.send({ id, body: { ok: true, count: row.trackIds.length, added } })
      }

      case 'playlist.setTracks': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!params?.id) return safeErr(id, ERR.BAD_PARAMS, 'id required')
        const row = await state.setPlaylistTracks(ownerOf(grant), params.id, params?.trackIds)
        if (!row) return safeErr(id, ERR.NOT_FOUND, 'no such playlist')
        log('playlist:set-tracks', { id: row.id, count: row.trackIds.length })
        return send.res.send({ id, body: { ok: true, count: row.trackIds.length } })
      }

      // --- play session: cross-device handoff (proposal 2026-07-17) ----------
      //
      // ownerOf(grant) keys the session to the PERSON; grant.deviceKey identifies WHICH of
      // their devices is acting. Both come from the Noise-authenticated connection, never a
      // param - a device can only ever touch its own owner's session and claim as itself.
      case 'session.get': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        const row = await state.getSession(ownerOf(grant))
        if (!row) return send.res.send({ id, body: null })
        // Enrich so the app can render "Playing on <name>" / "Play here" with no extra lookup:
        // is THIS device the active one, and if not, what is the active device called.
        const isActiveHere = row.activeDeviceKey === grant.deviceKey
        let activeDeviceName = null
        if (!isActiveHere && grants) {
          const g = await grants.get(row.activeDeviceKey)
          activeDeviceName = g?.label || null
        }
        return send.res.send({ id, body: { ...row, isActiveHere, activeDeviceName } })
      }

      case 'session.claim': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        const owner = ownerOf(grant)
        // Who held the token BEFORE this claim - so we can tell them, instantly, that they lost
        // it (instead of them finding out lazily on their next heartbeat, deferred follow-up #1).
        const prev = (await state.getSession(owner))?.activeDeviceKey || null
        // Compare-and-set on the generation the client last saw. null = it lost the race.
        const row = await state.claimSession(owner, grant.deviceKey, Number(params?.generation) || 0)
        // Push only on a SUCCESSFUL takeover from a DIFFERENT device (an idempotent re-claim by
        // the current holder, or a lost CAS race, must not tell anyone to stop). presence is
        // null in the unit tests; the push is best-effort and never gates the reply.
        let pushed = 0
        if (row && prev && prev !== grant.deviceKey && presence) {
          pushed = presence.notify(prev, 'session-superseded', { generation: row.generation })
        }
        log('session:claim', { ok: !!row, generation: row?.generation ?? null, superseded: pushed })
        return send.res.send({ id, body: { ok: !!row, session: row } })
      }

      case 'session.set': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        // Only the active device may write. null (ok:false) = superseded - the client learns
        // here that it lost the token (lazy presence) and pauses.
        const row = await state.setSession(ownerOf(grant), grant.deviceKey, params || {})
        return send.res.send({ id, body: { ok: !!row, session: row } })
      }

      case 'art.get': {
        const stream = await getAdapter().art(params || {})
        if (!stream) return safeErr(id, ERR.NOT_FOUND, 'no artwork')
        return pipeStream(id, stream)
      }

      case 'media.stream': {
        if (!params?.trackId) return safeErr(id, ERR.BAD_PARAMS, 'trackId required')
        const stream = await getAdapter().stream(params)
        if (!stream) return safeErr(id, ERR.NOT_FOUND, 'no such track')
        return pipeStream(id, stream)
      }

      default:
        // Typed, and the channel survives. An old host must degrade in front of
        // a newer client rather than wedge it (proposal, Compat).
        return safeErr(id, ERR.NO_METHOD, `unknown method: ${method}`)
    }
  }

  return channel
}

module.exports = { serveMedia, ownerOf }
