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
const MUTATING = new Set(['identity.set', 'fav.set', 'resume.set'])

// WHO owns the user state on this connection. Derived from the grant the firewall
// looked up from the Noise-authenticated remote key - NEVER from a client parameter,
// which is the whole reason host-as-hub is safe (there is nothing to forge). A device
// assigned to a person owns state as that person (so their phone + tablet share it);
// an unclaimed device is its own owner until the operator confirms a claim.
function ownerOf (grant) {
  return grant.personId ? 'p:' + grant.personId : 'd:' + grant.deviceKey
}

function serveMedia ({ conn, libraryId, getAdapter, grant, grants = null, state = null, log = () => {} }) {
  const mux = Protomux.from(conn)

  // Registration order is fixed in protocol/channels.js and MUST match the
  // client's. Do not hand-roll addMessage here - see the note in that file.
  const built = mediaChannel(mux, {
    id: b4a.from(libraryId),
    onclose: () => log('media:channel-closed'),
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
        return send.res.send({ id, body: row ? { trackId: row.trackId, positionMs: row.positionMs, durationMs: row.durationMs } : null })
      }

      case 'resume.set': {
        if (!state || !grant) return safeErr(id, ERR.FORBIDDEN, 'no grant')
        if (!params?.trackId) return safeErr(id, ERR.BAD_PARAMS, 'trackId required')
        await state.setResume(ownerOf(grant), params.trackId, Number(params.positionMs) || 0, params.durationMs)
        log('resume:set', { positionMs: Number(params.positionMs) || 0 })
        return send.res.send({ id, body: { ok: true } })
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
