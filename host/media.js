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
const { REQUEST_KINDS } = require('./state')

// Methods that mutate. A readonly grant is refused HERE rather than at the adapter,
// so a new mutating method cannot accidentally ship without a scope check.
const MUTATING = new Set([
  'identity.set', 'identity.avatar', 'fav.set', 'resume.set', 'count.bump',
  'playlist.create', 'playlist.rename', 'playlist.delete', 'playlist.add', 'playlist.setTracks',
  'session.claim', 'session.set',
  // Filing a music request writes a host row, so a readonly grant is refused here
  // (proposal 2026-07-24, P1). Resolving is dashboard-only, not a media method.
  'request.add',
  // Removing your OWN request (You > Requests). Ownership is checked in the handler;
  // MUTATING just keeps a readonly grant out (it has no requests to remove anyway).
  'request.delete'
])

// WHO owns the user state on this connection. Derived from the grant the firewall
// looked up from the Noise-authenticated remote key - NEVER from a client parameter,
// which is the whole reason host-as-hub is safe (there is nothing to forge). A device
// assigned to a person owns state as that person (so their phone + tablet share it);
// an unclaimed device is its own owner until the operator confirms a claim.
function ownerOf (grant) {
  return grant.personId ? 'p:' + grant.personId : 'd:' + grant.deviceKey
}

function serveMedia ({ conn, libraryId, getAdapter, libraryName = null, grant, grants = null, state = null, presence = null, avatars = null, onLeave = null, owner = null, onStream = null, onNowPlaying = null, log = () => {} }) {
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
  if (presence) unregisterPresence = presence.register(grant.deviceKey, (evt) => { try { send.push.send(evt) } catch {} }, ownerOf(grant))

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
    // Disambiguated where two people share a name, so "belongs to Sam" on the phone names the
    // SAME Sam the dashboard's revoke button does (see grants.personLabels).
    const labels = person && grants ? await grants.personLabels() : null
    return {
      deviceName: row?.label || null,
      belongsTo: person ? (labels?.get(person.id) || person.name) : null,
      // The library's CURRENT name (a getter, read now), so a dashboard rename reflects on the
      // phone on its next connect - the app updates its stored host record + UI from this.
      libraryName: libraryName ? libraryName() : null,
      // The device's own guest expiry (null = permanent), so the phone can show a
      // "guest access expires in X" banner. Read from THIS connection's grant, never a
      // param - a device only ever learns its OWN access. Refreshed on every connect, so
      // an operator extending or clearing it on the dashboard reflects on the phone.
      expiresAt: row?.expiresAt ?? null,
      // Is THIS device the owner (proposal 2026-07-24, P2)? Off its own grant scope, so the
      // app shows the owner surface only for a device the dashboard actually made an owner.
      // Refreshed each connect, so a dashboard promote/revoke reflects on the next connect.
      owner: row?.scope === SCOPE.OWNER,
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
        // RE-READ the row. `grant` is this CONNECTION's grant, captured once when the firewall
        // admitted it, so answering from it made identity.get report the state as of connect
        // time for the whole life of the connection - it could never see a claim the device had
        // just made, nor an operator confirming/renaming/assigning on the dashboard.
        //
        // That is what made a fresh pair sit on "Waiting for your server to confirm you are X"
        // while the host had already auto-created and assigned the person: identity.set wrote the
        // row and replied with fresh data, but the identity.get 13ms later still answered from the
        // stale snapshot (measured on-device 2026-07-21). Only a reconnect cleared it, which is
        // exactly why relaunching the app "fixed" it.
        const row = (grants && grant) ? await grants.get(grant.deviceKey) : null
        return send.res.send({ id, body: await identityOf(row || grant) })
      }

      case 'identity.set': {
        if (!grants || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')

        // params.deviceKey and params.personId are IGNORED, not merely unused: a
        // device names ITSELF, and only the operator decides who it belongs to.
        // A claim is cosmetic until confirmed on the dashboard.
        const row = await grants.setIdentity(grant.deviceKey, {
          deviceName: params?.deviceName,
          userName: params?.userName,
          // Additive: an older phone omits it and its platform is left as the grant recorded it.
          platform: params?.platform
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

      // The phone removed this library / unpaired: drop ITS OWN access here (proposal
      // 2026-07-20). Like identity.set, the subject is THIS connection's grant (grant.deviceKey,
      // Noise-authenticated) - there is no deviceKey param to forge, so a device can only ever
      // leave on its own behalf. Allowed for ANY scope (relinquishing your own access is the
      // least-privileged action), so it is deliberately NOT in the MUTATING scope gate. Reply
      // BEFORE onLeave, which revokes the grant and destroys THIS connection.
      case 'device.leave': {
        if (!grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        send.res.send({ id, body: { ok: true } })
        if (onLeave) { try { await onLeave(grant.deviceKey) } catch (e) { log('device:leave-failed', { err: e?.message }) } }
        return
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
        // TELL THIS PERSON'S OTHER DEVICES, or they show the old hearts until something makes
        // them ask again - and nothing does while the app sits connected, which is why a
        // favorite made on one phone only appeared on the other after a relaunch (Tim,
        // 2026-07-30; proposal 2026-07-30-favorites-live-update). Not the device that just
        // wrote it: it already re-rendered, and a push would fight its own optimistic update.
        // Best-effort, and never gates the reply - presence is null in the unit tests.
        let told = 0
        if (presence) {
          told = presence.notifyOwner(ownerOf(grant), 'favorites:changed',
            { kind: row.kind, id: row.id, on: row.on, libraryId },
            { exceptDevice: grant.deviceKey })
        }
        log('fav:set', { kind: row.kind, on: row.on, told })
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
        // Scoped to the asking device (proposal 2026-07-30-one-device-plays): the card answers
        // "what was I playing on THIS phone", with the person-wide newest as a fallback.
        const row = await state.latestResume(ownerOf(grant), grant.deviceKey)
        // updatedAt lets the merged client pick the globally-newest resume across hosts, and
        // playedAt lets it order by when the device LISTENED rather than when the write landed
        // (an outbox flush lands late). An old host sends no playedAt; the client falls back.
        return send.res.send({ id, body: row ? { trackId: row.trackId, positionMs: row.positionMs, durationMs: row.durationMs, updatedAt: row.updatedAt || 0, playedAt: row.playedAt || row.updatedAt || 0 } : null })
      }

      case 'resume.set': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!params?.trackId) return safeErr(id, ERR.BAD_PARAMS, 'trackId required')
        // playedAt is the CLIENT's clock (when it actually listened) - the one thing the host
        // cannot know, because a write can arrive from an outbox hours later. deviceKey comes
        // from the authenticated connection, never a param: a device may only ever write as
        // itself, exactly as everywhere else in this file.
        await state.setResume(ownerOf(grant), params.trackId, Number(params.positionMs) || 0, params.durationMs, {
          playedAt: Number(params.playedAt) || 0,
          deviceKey: grant.deviceKey
        })
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

      // --- music requests (proposal 2026-07-24-owner-in-the-app, P1) --------
      //
      // A device asks the operator to add music. The REQUESTER is ownerOf(grant) -
      // host-derived, never a param - so a request cannot be filed on someone else's
      // behalf, and request.list can only ever return the caller's own. Resolving is
      // the operator's job and lives on the dashboard API, not here.
      case 'request.add': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!REQUEST_KINDS.includes(params?.kind)) return safeErr(id, ERR.BAD_PARAMS, 'kind must be artist, album or track')
        let row
        try {
          row = await state.addRequest(ownerOf(grant), {
            kind: params.kind, name: params.name, artist: params.artist, album: params.album, mbid: params.mbid
          })
        } catch (e) {
          return safeErr(id, ERR.BAD_PARAMS, e.message || 'bad request')
        }
        log('request:add', { kind: row.kind, folded: row.count > 1 })
        // P3: nudge every CONNECTED owner so a request is not a dead-drop nobody reads. Best-effort
        // by design (Tier A) - if no owner is online it just waits, and the dashboard/badge still
        // shows it on their next open. The owner set is the grant store's authority (scope OWNER,
        // not revoked); presence.notify only reaches the ones with a live channel. requesterName is
        // derived host-side from the caller's own grant, the same way the dashboard names it.
        if (presence && grants) {
          let requesterName = 'Someone'
          if (grant.personId) {
            // Suffixed where two people share a name - "Sam asked" must not be a coin flip on
            // the banner that an owner acts on.
            const labels = await grants.personLabels().catch(() => null)
            requesterName = labels?.get(grant.personId) ||
              (await grants.getPerson(grant.personId).catch(() => null))?.name || 'Someone'
          } else requesterName = grant.label || 'A device'
          const payload = { id: row.id, kind: row.kind, name: row.name, artist: row.artist, requesterName, count: row.count }
          for (const g of await grants.list().catch(() => [])) {
            if (g.scope === SCOPE.OWNER && !g.revokedAt) presence.notify(g.deviceKey, 'request:new', payload)
          }
        }
        return send.res.send({ id, body: { ok: true, id: row.id, status: row.status, count: row.count } })
      }

      case 'request.list': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        // The caller's OWN requests only - the operator's all-requests view is dashboard-side.
        return send.res.send({ id, body: { requests: await state.listRequests({ requester: ownerOf(grant) }) } })
      }

      // --- owner maintenance (proposal 2026-07-24-owner-in-the-app, P2) -----
      //
      // Gated on the OWNER scope, which is minted only by pairing through the dashboard's
      // owner window (host-side) - a phone can never assert it. The gate is here at
      // dispatch, so a full/readonly/guest grant is refused before any owner op runs.
      // BECOME an owner over this existing connection (P2, the connected-device promote path).
      // NOT gated on owner scope - this is how a full device becomes an owner. It IS gated on
      // having a grant (only a paired device has a media channel) AND presenting the open owner
      // window's one-time code, which the host checks. So a random device cannot self-promote.
      case 'owner.claim': {
        if (!owner || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!params?.code) return safeErr(id, ERR.BAD_PARAMS, 'code required')
        const r = await owner.claim(grant.deviceKey, params.code)
        if (!r.ok) return safeErr(id, ERR.FORBIDDEN, r.reason || 'owner claim rejected')
        // The store row is now owner, but THIS connection's captured `grant` still says its
        // old scope - so raise it in-memory too, or the very next owner.* on this same
        // connection would be refused until a reconnect (same staleness identity.get re-reads
        // around). The gate reads grant.scope, so this makes the promotion effective at once.
        grant.scope = SCOPE.OWNER
        log('owner:claim')
        return send.res.send({ id, body: { ok: true } })
      }

      case 'owner.devices': {
        if (!owner) return safeErr(id, ERR.INTERNAL, 'owner ops unavailable')
        if (grant?.scope !== SCOPE.OWNER) return safeErr(id, ERR.FORBIDDEN, 'owner only')
        return send.res.send({ id, body: { devices: await owner.listDevices() } })
      }

      // Open a pairing window remotely so the owner can let a device in while away (P2b).
      // A NORMAL/guest window only - owner.pairStart never mints an owner grant (server binds
      // owner:false), so a stolen owner phone cannot make more owners.
      case 'owner.pairStart': {
        if (!owner) return safeErr(id, ERR.INTERNAL, 'owner ops unavailable')
        if (grant?.scope !== SCOPE.OWNER) return safeErr(id, ERR.FORBIDDEN, 'owner only')
        const link = owner.pairStart({ expiresMs: Number(params?.expiresMs) > 0 ? Number(params.expiresMs) : null })
        log('owner:pair-start', { guest: !!params?.expiresMs })
        return send.res.send({ id, body: { link } })
      }

      case 'owner.pairStop': {
        if (!owner) return safeErr(id, ERR.INTERNAL, 'owner ops unavailable')
        if (grant?.scope !== SCOPE.OWNER) return safeErr(id, ERR.FORBIDDEN, 'owner only')
        owner.pairStop()
        return send.res.send({ id, body: { ok: true } })
      }

      case 'owner.pairState': {
        if (!owner) return safeErr(id, ERR.INTERNAL, 'owner ops unavailable')
        if (grant?.scope !== SCOPE.OWNER) return safeErr(id, ERR.FORBIDDEN, 'owner only')
        return send.res.send({ id, body: owner.pairState() })
      }

      // The full request queue (all requesters) + resolve, so the owner can work it from the
      // phone away from the dashboard (P2b).
      case 'owner.requests': {
        if (!owner) return safeErr(id, ERR.INTERNAL, 'owner ops unavailable')
        if (grant?.scope !== SCOPE.OWNER) return safeErr(id, ERR.FORBIDDEN, 'owner only')
        return send.res.send({ id, body: { requests: await owner.requests() } })
      }

      case 'owner.requestResolve': {
        if (!owner) return safeErr(id, ERR.INTERNAL, 'owner ops unavailable')
        if (grant?.scope !== SCOPE.OWNER) return safeErr(id, ERR.FORBIDDEN, 'owner only')
        if (!params?.id || !['added', 'declined'].includes(params?.status)) return safeErr(id, ERR.BAD_PARAMS, 'id and status (added|declined) required')
        const row = await owner.resolveRequest(params.id, params.status)
        if (!row) return send.res.send({ id, body: { ok: false, notFound: true } })
        log('owner:request-resolve', { status: row.status })
        return send.res.send({ id, body: { ok: true, status: row.status } })
      }

      case 'owner.revoke': {
        if (!owner) return safeErr(id, ERR.INTERNAL, 'owner ops unavailable')
        if (grant?.scope !== SCOPE.OWNER) return safeErr(id, ERR.FORBIDDEN, 'owner only')
        if (!params?.deviceKey) return safeErr(id, ERR.BAD_PARAMS, 'deviceKey required')
        // An owner phone may NOT revoke another OWNER device (proposal security review):
        // owner-vs-owner stays a dashboard-only action, so a stolen owner phone cannot lock
        // out the real owner's other owner devices. It CAN revoke full/guest/readonly.
        const target = await owner.getGrant(params.deviceKey)
        if (target && !target.revokedAt && target.scope === SCOPE.OWNER) {
          return safeErr(id, ERR.FORBIDDEN, 'revoke an owner device from the dashboard')
        }
        const { grant: row, killed } = await owner.revokeDevice(params.deviceKey)
        if (!row) return send.res.send({ id, body: { ok: false, notFound: true } })
        log('owner:revoke', { killed })
        return send.res.send({ id, body: { ok: true, killed } })
      }

      case 'request.delete': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!params?.id) return safeErr(id, ERR.BAD_PARAMS, 'id required')
        // You can only remove YOUR OWN request. The requester on the row is host-derived
        // (ownerOf), so this compares the caller's identity to it - a device cannot delete
        // someone else's request by guessing an id. A resolved OR a pending one (withdraw).
        const row = await state.getRequest(params.id)
        if (!row) return send.res.send({ id, body: { ok: true, deleted: false } }) // already gone
        if (row.requester !== ownerOf(grant)) return safeErr(id, ERR.FORBIDDEN, 'not your request')
        const deleted = await state.deleteRequest(params.id)
        log('request:delete', { deleted })
        return send.res.send({ id, body: { ok: true, deleted } })
      }

      // --- play session: cross-device handoff (proposal 2026-07-17) ----------
      //
      // ownerOf(grant) keys the session to the PERSON; grant.deviceKey identifies WHICH of
      // their devices is acting. Both come from the Noise-authenticated connection, never a
      // param - a device can only ever touch its own owner's session and claim as itself.
      case 'session.get': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        // merged = the cross-host session (phase 3): a distinct row keyed the same owner,
        // holding a queue that spans hosts. Same auth, same shape.
        const merged = !!params?.merged
        const row = await state.getSession(ownerOf(grant), merged)
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
        const merged = !!params?.merged
        const owner = ownerOf(grant)
        // Who held the token BEFORE this claim - so we can tell them, instantly, that they lost
        // it (instead of them finding out lazily on their next heartbeat, deferred follow-up #1).
        const prev = (await state.getSession(owner, merged))?.activeDeviceKey || null
        // Compare-and-set on the generation the client last saw. null = it lost the race.
        const row = await state.claimSession(owner, grant.deviceKey, Number(params?.generation) || 0, merged)
        // Push only on a SUCCESSFUL takeover from a DIFFERENT device (an idempotent re-claim by
        // the current holder, or a lost CAS race, must not tell anyone to stop). presence is
        // null in the unit tests; the push is best-effort and never gates the reply.
        let pushed = 0
        if (row && prev && prev !== grant.deviceKey && presence) {
          pushed = presence.notify(prev, 'session-superseded', { generation: row.generation, merged })
        }
        log('session:claim', { merged, ok: !!row, generation: row?.generation ?? null, superseded: pushed })
        return send.res.send({ id, body: { ok: !!row, session: row } })
      }

      case 'session.set': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        // Only the active device may write. null (ok:false) = superseded - the client learns
        // here that it lost the token (lazy presence) and pauses.
        const row = await state.setSession(ownerOf(grant), grant.deviceKey, params || {}, !!params?.merged)
        return send.res.send({ id, body: { ok: !!row, session: row } })
      }

      case 'art.get': {
        const stream = await getAdapter().art(params || {})
        if (!stream) return safeErr(id, ERR.NOT_FOUND, 'no artwork')
        return pipeStream(id, stream)
      }

      // What the device is playing FROM US right now. The phone is the only party that knows -
      // a host sees requests, not playback, and it cannot tell when someone moved to a track
      // another library serves (proposal 2026-07-28). Deliberately NOT persisted and NOT
      // acknowledged with anything but ok: it describes this instant and expires on its own.
      case 'nowplaying.set': {
        if (onNowPlaying) onNowPlaying(params || null)
        return send.res.send({ id, body: { ok: true } })
      }

      case 'media.stream': {
        if (!params?.trackId) return safeErr(id, ERR.BAD_PARAMS, 'trackId required')
        const stream = await getAdapter().stream(params)
        if (!stream) return safeErr(id, ERR.NOT_FOUND, 'no such track')
        // THIS host is the one serving these bytes, which is the only thing it knows for certain
        // about what a device is listening to (Tim, 2026-07-28: show now-playing where the music
        // is actually coming from). Recorded per device by the caller; unlike the play session it
        // needs no claim, so it works for a phone whose session lives on another library - or on
        // no library at all.
        if (onStream) onStream(params.trackId)
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
