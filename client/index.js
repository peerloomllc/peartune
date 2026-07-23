// The PearTune client: pairing and the media API, from the phone's side.
//
// Runs in Bare (inside the app's worklet) and in Node (the integration tests),
// so it must not touch a Node-only API. Everything here is hyperdht/protomux
// plus the shared protocol module.

const HyperDHT = require('hyperdht')
const Protomux = require('protomux')
const b4a = require('b4a')
const z32 = require('z32')

const { pairChannel, mediaChannel } = require('../protocol/channels')
const { parseLink } = require('../protocol/link')
const { libraryId: deriveLibraryId } = require('../protocol/ids')
const { ERR } = require('../protocol/constants')

// How long to wait for a media connect before calling the host unreachable. A REFUSAL
// (firewall deny) arrives much faster as a `close`; this only bounds the "no route to
// the host at all" case so a doomed reconnect does not hang forever.
const CONNECT_TIMEOUT = 20000

// How long we will wait for the DHT node to finish bootstrapping before dialing anyway.
// Best-effort: a slow or failing bootstrap must never be the thing that stops a pair.
const READY_TIMEOUT = 5000

// Pairing dial attempts, and the elapsed budget after which we stop retrying. A dial that
// dies BEFORE the connection opens is ambiguous by construction (see _pairOnce), so a
// retry is the only thing that separates a real refusal from a blip. Measured against a
// hyperdht testnet: a firewall deny surfaces as PEER_CONNECTION_FAILED after ~4s and a
// host with no DHT record as PEER_NOT_FOUND in ~1ms, so the budget - not the count - is
// what bounds how long a genuinely closed window takes to report.
const PAIR_ATTEMPTS = 3
const PAIR_RETRY_BUDGET_MS = 8000
const PAIR_RETRY_GAP_MS = 500

// CONNECT gets the same treatment, and for a measured reason. Off-LAN on cellular, two
// diagnostics runs eight minutes apart on the SAME phone and the same DHT node: the first
// aborted the hole-punch against both hosts after ~11s, the second reached both in ~1.6s.
// The punch is INTERMITTENT on a carrier NAT, so a single dial reports a hard failure for
// something a retry a moment later just... does. Pairing has retried since #125; connect
// never did, which is why "I can't connect when I'm out" and "it works now" were both true.
// The budget has to cover the WORST CASE of an attempt, not the average, because an aborted
// hole-punch is slow to fail. Measured on Tim's Pixel, off-LAN on 5G, both hosts, both with
// and without Tailscale: a failing attempt costs 4-12s (hyperdht gives up around 11.5s) and
// the one that WORKS lands in 0.5-1.7s. Typical: fail 11.6s, fail 11.7s, succeed 1.7s.
//
// The first cut of this retry used a 14s budget copied from pair(), which stopped exactly ONE
// attempt before the one that would have connected - so the diagnostics screen (no budget,
// three dials) reached both libraries while the app itself reported them unreachable, on the
// same phone, seconds apart. That is the bug this constant exists to not have.
//
// 45s is deliberately generous: it only ever elapses when the host was FOUND and the punch is
// failing, which is precisely when persisting pays. A host that is off answers PEER_NOT_FOUND
// in milliseconds, so all attempts finish in ~2s and nobody waits.
const CONNECT_ATTEMPTS = 4
const CONNECT_RETRY_BUDGET_MS = 45000
const CONNECT_RETRY_GAP_MS = 600

// What one failing attempt costs in the field, from the reports above. The budget must leave
// room to START another attempt after two of them - see test/connect-policy.test.js.
const OBSERVED_WORST_ATTEMPT_MS = 12000

class PearTuneClient {
  constructor ({ keyPair, dht = null, bootstrap = null, log = () => {} }) {
    this.keyPair = keyPair
    this._ownDht = !dht
    this.dht = dht || new HyperDHT(bootstrap ? { bootstrap } : {})
    this.log = log

    this.conn = null
    this.channel = null
    this.send = null
    this.libraryId = null
    this.hostKey = null

    this._nextId = 1
    this._pending = new Map() // req id -> { resolve, reject, stream? }

    // The host's unsolicited push (session handoff). The worklet sets this to react to a
    // 'session-superseded' event instantly instead of waiting for the next lazy heartbeat.
    this.onPush = null
  }

  // --- pairing -------------------------------------------------------------

  // Scan the QR and dial the host directly by the key printed in it.
  //
  // Dialing by key is what makes an impostor impossible: HyperDHT's Noise
  // handshake authenticates the far end AS that key, so a peer who merely
  // photographed the QR cannot answer this call. We do not need to check who
  // picked up, because only one keyholder can.
  //
  // We still have to prove OURSELVES, which is what `rv` is for. The host's
  // public key is an address, not a secret, so dialing it proves nothing. The
  // token from the QR does.
  async pair (link, { label = 'phone', platform = 'android', timeout = 60000, attempts = PAIR_ATTEMPTS } = {}) {
    const parsed = parseLink(link)

    // Dial off a WARM node. A cold HyperDHT has an empty routing table, so the very first
    // connect races its own bootstrap and can fail as "could not connect" with the host
    // sitting right there on the LAN - then the immediate retry, off the now-warm node,
    // succeeds. That is the intermittent pairing failure people hit on a first pair, and
    // it is the same transient src/bare.js keeps ONE dht node alive to avoid.
    await this._ready()

    const started = Date.now()
    let last = null

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const left = timeout - (Date.now() - started)
      if (left <= 0) break

      try {
        return await this._pairOnce(parsed, { label, platform, timeout: left })
      } catch (e) {
        last = e

        // A host that ADMITTED us and then hung up has made a decision - wrong token,
        // window shut, key mismatch. Dialing again only asks the same question.
        if (e.code !== 'EUNREACHABLE') throw e

        this.log('pair:dial-failed', { attempt, code: e.dhtCode || null })
        if (attempt === attempts) break
        if (Date.now() - started >= PAIR_RETRY_BUDGET_MS) break
        await new Promise((resolve) => {
          const t = setTimeout(resolve, PAIR_RETRY_GAP_MS)
          if (t.unref) t.unref()
        })
      }
    }

    throw last || new Error('pairing failed')
  }

  // One dial. Rejects with a `code` the caller can act on:
  //
  //   EREFUSED     - the connection OPENED (Noise completed, so the host's firewall
  //                  admitted us) and the host then hung up. That is a decision.
  //   EUNREACHABLE - it never opened. hyperdht cannot tell us WHY: a firewall deny and a
  //                  network that dropped the holepunch are both PEER_CONNECTION_FAILED.
  //                  So this must never be reported as "your code expired" - we do not
  //                  know that, and asserting it sent a past debugging session the wrong
  //                  way down the pipe.
  //   ETIMEDOUT    - nothing happened at all inside the budget.
  _pairOnce ({ rv, hostKey, name }, { label, platform, timeout }) {
    // The library id is not yet known (it is one of the things pairing tells us),
    // but the pair channel is keyed on it. Derive it: it is a pure function of
    // the host key, which the QR gave us.
    const libId = deriveLibraryId(hostKey)

    const conn = this.dht.connect(hostKey, { keyPair: this.keyPair })

    // Kept, not swallowed: the hyperdht code (PEER_NOT_FOUND, PEER_CONNECTION_FAILED,
    // CANNOT_HOLEPUNCH) is the only forensic detail a field report ever has.
    let dialError = null
    conn.on('error', (e) => { dialError = e })

    let opened = false

    const unreachable = () => {
      const e = new Error('no answer from the host (unreachable, or not accepting pair requests)')
      e.code = 'EUNREACHABLE'
      e.dhtCode = dialError?.code || null
      return e
    }

    return (async () => {
      try {
        return await new Promise((resolve, reject) => {
          let settled = false
          const done = (fn, arg) => { if (!settled) { settled = true; fn(arg) } }

          const timer = setTimeout(() => {
            const e = new Error('pairing timed out')
            e.code = 'ETIMEDOUT'
            done(reject, e)
          }, timeout)
          if (timer.unref) timer.unref()

          conn.once('close', () => {
            clearTimeout(timer)
            if (opened) {
              const e = new Error('host refused the pairing code')
              e.code = 'EREFUSED'
              done(reject, e)
              return
            }
            done(reject, unreachable())
          })

          conn.opened.then(() => {
            opened = true
            const mux = Protomux.from(conn)

            const built = pairChannel(mux, {
              id: b4a.from(libId),
              onpaired: (m) => {
                clearTimeout(timer)
                this.log('pair:done', { libraryId: m?.libraryId })
                done(resolve, {
                  hostKey,
                  libraryId: m?.libraryId ?? libId,
                  libraryName: m?.libraryName ?? name
                })
              }
            })
            if (!built) {
              clearTimeout(timer)
              return done(reject, new Error('could not open pair channel'))
            }

            built.channel.open()
            built.messages.hello.send({ rv, deviceKey: this.keyPair.publicKey, label, platform })
          }).catch(() => {
            clearTimeout(timer)
            done(reject, unreachable())
          })
        })
      } finally {
        conn.destroy()
      }
    })()
  }

  // Wait for the dht node to finish bootstrapping, but never for long. Best-effort on
  // purpose: if the bootstrap is slow or failing, the dial itself will say so far more
  // usefully than a hang here would.
  async _ready (timeout = READY_TIMEOUT) {
    const boot = typeof this.dht.fullyBootstrapped === 'function'
      ? this.dht.fullyBootstrapped()
      : (typeof this.dht.ready === 'function' ? this.dht.ready() : null)
    if (!boot) return

    let timer = null
    try {
      await Promise.race([
        boot,
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeout)
          if (timer.unref) timer.unref()
        })
      ])
    } catch {
      // a bootstrap that rejected is not a pairing failure
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // --- steady state --------------------------------------------------------

  // ONE dial. Rejects with EUNREACHABLE for anything that failed BEFORE the connection
  // opened - which is every failure this can see.
  //
  // It used to call that EREFUSED ("host refused the connection"), which reads as a
  // DECISION by the host. It is not one, and cannot be: a hole-punch that never completes
  // closes exactly like a firewall deny, which is why the offline lease refuses to purge on
  // it (see the note in src/bare.js) and why #125 stopped the pairing copy asserting a
  // cause it could not know. A carrier NAT dropping the punch was being reported to the
  // user as the server turning them away.
  _connectOnce () {
    const conn = this.dht.connect(this.hostKey, { keyPair: this.keyPair })
    let dialError = null
    conn.on('error', (e) => { dialError = e })

    return new Promise((resolve, reject) => {
      let settled = false
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg) } }
      const fail = (msg, code) => {
        const e = new Error(msg)
        e.code = code
        // The hyperdht code (HOLEPUNCH_ABORTED, PEER_NOT_FOUND, PEER_CONNECTION_FAILED) is
        // the only forensic detail a field report ever has - keep it, do not flatten it.
        e.dhtCode = dialError?.code || null
        return e
      }
      const timer = setTimeout(() => done(reject, fail('connect timed out', 'ETIMEDOUT')), CONNECT_TIMEOUT)
      if (timer.unref) timer.unref()
      conn.once('close', () => { clearTimeout(timer); done(reject, fail('could not reach the host', 'EUNREACHABLE')) })
      conn.opened
        .then(() => { clearTimeout(timer); done(resolve, conn) })
        .catch(() => { clearTimeout(timer); done(reject, fail('could not reach the host', 'EUNREACHABLE')) })
    }).catch((e) => { try { conn.destroy() } catch {} ; throw e })
  }

  async connect ({ hostKey, libraryId }) {
    this.hostKey = typeof hostKey === 'string' ? z32.decode(hostKey) : hostKey
    this.libraryId = libraryId

    // Same reason as in pair(): the FIRST connect off a cold node races its own bootstrap.
    // A no-op once the node is warm, which it is for every connect after the first.
    await this._ready()

    const started = Date.now()
    let conn = null
    let last = null

    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
      try {
        conn = await this._connectOnce()
        break
      } catch (e) {
        last = e
        this.log('connect:dial-failed', { attempt, code: e.code, dhtCode: e.dhtCode || null })
        if (attempt === CONNECT_ATTEMPTS) throw e
        if (Date.now() - started >= CONNECT_RETRY_BUDGET_MS) throw e
        await new Promise((resolve) => {
          const t = setTimeout(resolve, CONNECT_RETRY_GAP_MS)
          if (t.unref) t.unref()
        })
      }
    }
    if (!conn) throw last || new Error('connect failed')

    // #149's retry refactor dropped this line, and it is load-bearing: poolClient() in
    // src/bare.js gates on `client.conn && !client.conn.destroyed`, so a pool client whose
    // .conn was never set reads as PERMANENTLY DISCONNECTED. That is why the merged view
    // showed "can't reach your libraries" while the raw diagnostics dial reached both hosts
    // in the same instant - the pool connected fine and then declared itself offline.
    this.conn = conn
    return this._wireMedia(conn, libraryId)
  }

  // Wire the media channel onto a connection someone ELSE established, rather than
  // dialing one here (proposal 2026-07-22 phase 2). A Hyperswarm 'connection' hands
  // back the same UDX+remotePublicKey object dht.connect does, so everything above
  // the socket - Protomux, the media channel, the pending map, revoke's mid-flight
  // fail - is identical; only how the socket was obtained differs. src/bare.js's
  // active-host path uses this against its persistent swarm membership; connect()
  // above (still used by the merged pool + queued leaves until phase 3) simply dials
  // first and then calls the same wiring.
  attach (conn, { libraryId }) {
    this.conn = conn
    this.libraryId = libraryId
    this.hostKey = conn.remotePublicKey || this.hostKey
    return this._wireMedia(conn, libraryId)
  }

  _wireMedia (conn, libraryId) {
    const mux = Protomux.from(conn)

    // Registration order is fixed in protocol/channels.js and MUST match the
    // host's. Do not hand-roll addMessage here - see the note in that file.
    const built = mediaChannel(mux, {
      id: b4a.from(libraryId),
      onclose: () => this._failAll(new Error('channel closed')),

      onres: (m) => {
        const p = this._pending.get(m.id)
        if (!p) return
        this._pending.delete(m.id)
        p.resolve(m.body)
      },

      onchunk: (m) => {
        const p = this._pending.get(m.id)
        if (!p) return
        if (p.chunks) p.chunks.push(m.data)
        if (p.onchunk) p.onchunk(m.data)
      },

      onend: (m) => {
        const p = this._pending.get(m.id)
        if (!p) return
        this._pending.delete(m.id)

        // Unbuffered (the audio shim): nothing was accumulated, so just report
        // how much flowed.
        if (!p.buffered) return p.resolve({ total: m.total })

        const body = b4a.concat(p.chunks || [])
        // `total` is not decoration: it is what makes a resumed pinned download
        // safe to trust. A short read here means a truncated file on disk.
        if (body.length !== m.total) {
          p.reject(new Error(`truncated stream: got ${body.length}, expected ${m.total}`))
          return
        }
        p.resolve(body)
      },

      onerr: (m) => {
        const p = this._pending.get(m.id)
        if (!p) return
        this._pending.delete(m.id)
        const e = new Error(m.message || m.code)
        e.code = m.code
        p.reject(e)
      },

      // Unsolicited host event - no request id to correlate. Hand it straight to the
      // worklet; it decides what to do (today: 'session-superseded' -> stop and yield).
      onpush: (m) => { try { this.onPush && this.onPush(m) } catch {} }
    })
    if (!built) throw new Error('could not open media channel')

    this.send = { req: built.messages.req }
    built.channel.open()
    this.channel = built.channel

    // A revoked device's connection is destroyed by the host mid-flight, so
    // every in-flight request has to fail rather than hang forever.
    conn.once('close', () => this._failAll(new Error('connection closed')))

    return this
  }

  _failAll (err) {
    for (const [, p] of this._pending) p.reject(err)
    this._pending.clear()
  }

  _request (method, params, { stream = false, onchunk = null, buffer = true } = {}) {
    if (!this.send) return Promise.reject(new Error('not connected'))
    const id = this._nextId++
    return new Promise((resolve, reject) => {
      this._pending.set(id, {
        resolve,
        reject,
        // `buffer: false` streams straight through to onchunk and accumulates
        // nothing. The audio shim MUST use it: buffering a 100 MB FLAC in a
        // phone's worklet to hand it to a player that only wanted the next
        // second of audio is how you get an OOM kill.
        chunks: stream && buffer ? [] : null,
        buffered: stream && buffer,
        onchunk
      })
      this.send.req.send({ id, method, params: params ?? null })
    })
  }

  ping () { return this._request('ping') }
  stats () { return this._request('library.stats') }
  list (params) { return this._request('library.list', params) }
  get (params) { return this._request('library.get', params) }
  search (params) { return this._request('library.search', params) }

  // Identity. The host takes the caller from the Noise-authenticated connection, so
  // there is deliberately no device key to pass: a device names ITSELF, and only
  // the operator decides who it belongs to (proposal 2026-07-14).
  getIdentity () { return this._request('identity.get') }
  setIdentity (params) { return this._request('identity.set', params) }
  // Set (or clear) this device's own avatar - a small JPEG, base64 in params.avatar.
  setAvatar (params) { return this._request('identity.avatar', params) }

  // Leave: this device removed this library / unpaired, so drop its OWN grant on the host
  // (proposal 2026-07-20). The host revokes this connection's grant and cuts it, so removing a
  // library on the phone ends access here instead of leaving a live grant + stale dashboard row.
  // Best-effort: the caller swallows ENOMETHOD (an old host) or a close/offline rejection.
  deviceLeave () { return this._request('device.leave') }

  // Favorites (host-as-hub, milestone 3). No owner param: the host takes it from the
  // Noise-authenticated connection, exactly like identity above.
  favList () { return this._request('fav.list') }
  favSet (params) { return this._request('fav.set', params) }

  // Resume positions (milestone 3, phase 2).
  resumeGet (params) { return this._request('resume.get', params) }
  resumeSet (params) { return this._request('resume.set', params) }
  resumeLatest () { return this._request('resume.latest') }

  // Play counts (milestone 3, phase 3).
  countBump (params) { return this._request('count.bump', params) }
  countTop (params) { return this._request('count.top', params) }

  // Playlists (milestone 3, phase 4). Host-owned, single writer. No owner param - the
  // host takes it from the connection, same rule as favorites. The playlist id is
  // minted by the host on create.
  playlistList () { return this._request('playlist.list') }
  playlistGet (params) { return this._request('playlist.get', params) }
  playlistCreate (params) { return this._request('playlist.create', params) }
  playlistRename (params) { return this._request('playlist.rename', params) }
  playlistDelete (params) { return this._request('playlist.delete', params) }
  playlistAdd (params) { return this._request('playlist.add', params) }
  playlistSetTracks (params) { return this._request('playlist.setTracks', params) }

  // Play session (cross-device handoff, proposal 2026-07-17). The host takes the owner +
  // acting device from the connection; claim/set are gated by the generation CAS host-side.
  sessionGet (params) { return this._request('session.get', params) }
  sessionClaim (params) { return this._request('session.claim', params) }
  sessionSet (params) { return this._request('session.set', params) }

  art (params) { return this._request('art.get', params, { stream: true }) }

  // Resolves to the whole buffer. `onchunk` lets a caller start work before the
  // last byte lands.
  stream (params, onchunk) {
    return this._request('media.stream', params, { stream: true, onchunk })
  }

  // Streams straight through to `onchunk`, accumulating NOTHING, and resolves to
  // { total } when the last byte lands. This is what the audio shim uses: it is
  // feeding a player that wants the next second of audio, not a 100 MB buffer.
  streamTo (params, onchunk) {
    return this._request('media.stream', params, { stream: true, onchunk, buffer: false })
  }

  async close () {
    this._failAll(new Error('client closed'))
    if (this.conn) this.conn.destroy()
    if (this._ownDht) await this.dht.destroy()
  }
}

module.exports = {
  PearTuneClient,
  ERR,
  // Exported for test/connect-policy.test.js, which pins them against measured field timings.
  CONNECT_ATTEMPTS,
  CONNECT_RETRY_BUDGET_MS,
  CONNECT_RETRY_GAP_MS,
  CONNECT_TIMEOUT,
  OBSERVED_WORST_ATTEMPT_MS
}
