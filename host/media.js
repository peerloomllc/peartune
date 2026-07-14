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
const MUTATING = new Set(['identity.set'])

function serveMedia ({ conn, libraryId, adapter, grant, grants = null, log = () => {} }) {
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
        return send.res.send({ id, body: await adapter.stats() })

      case 'library.list':
        return send.res.send({ id, body: await adapter.list(params || {}) })

      case 'library.get':
        return send.res.send({ id, body: await adapter.get(params || {}) })

      case 'library.search':
        return send.res.send({ id, body: await adapter.search(params || {}) })

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

      case 'art.get': {
        const stream = await adapter.art(params || {})
        if (!stream) return safeErr(id, ERR.NOT_FOUND, 'no artwork')
        return pipeStream(id, stream)
      }

      case 'media.stream': {
        if (!params?.trackId) return safeErr(id, ERR.BAD_PARAMS, 'trackId required')
        const stream = await adapter.stream(params)
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

module.exports = { serveMedia }
