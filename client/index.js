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
  async pair (link, { label = 'phone', platform = 'android', timeout = 60000 } = {}) {
    const { rv, hostKey, name } = parseLink(link)

    // The library id is not yet known (it is one of the things pairing tells us),
    // but the pair channel is keyed on it. Derive it: it is a pure function of
    // the host key, which the QR gave us.
    const libId = deriveLibraryId(hostKey)

    const conn = this.dht.connect(hostKey, { keyPair: this.keyPair })
    conn.on('error', () => {})

    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('pairing timed out')), timeout)
        if (timer.unref) timer.unref()

        // If the host has no pairing window open, its firewall denies us and the
        // connection dies here rather than hanging until the timeout.
        conn.once('close', () => {
          clearTimeout(timer)
          reject(new Error('host refused the connection (is a pairing window open?)'))
        })

        conn.opened.then(() => {
          const mux = Protomux.from(conn)

          const built = pairChannel(mux, {
            id: b4a.from(libId),
            onpaired: (m) => {
              clearTimeout(timer)
              this.log('pair:done', { libraryId: m?.libraryId })
              resolve({
                hostKey,
                libraryId: m?.libraryId ?? libId,
                libraryName: m?.libraryName ?? name
              })
            }
          })
          if (!built) return reject(new Error('could not open pair channel'))

          built.channel.open()
          built.messages.hello.send({ rv, deviceKey: this.keyPair.publicKey, label, platform })
        }).catch(reject)
      })
    } finally {
      conn.destroy()
    }
  }

  // --- steady state --------------------------------------------------------

  async connect ({ hostKey, libraryId }) {
    this.hostKey = typeof hostKey === 'string' ? z32.decode(hostKey) : hostKey
    this.libraryId = libraryId

    const conn = this.dht.connect(this.hostKey, { keyPair: this.keyPair })
    conn.on('error', () => {})
    await conn.opened

    this.conn = conn
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
      }
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

  // Favorites (host-as-hub, milestone 3). No owner param: the host takes it from the
  // Noise-authenticated connection, exactly like identity above.
  favList () { return this._request('fav.list') }
  favSet (params) { return this._request('fav.set', params) }

  // Resume positions (milestone 3, phase 2).
  resumeGet (params) { return this._request('resume.get', params) }
  resumeSet (params) { return this._request('resume.set', params) }

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

module.exports = { PearTuneClient, ERR }
