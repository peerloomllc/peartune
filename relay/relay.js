// The blind relay node (proposal 2026-07-23-blind-relay, T3, phase 1).
//
// A public-IP HyperDHT node that runs a `blind-relay` server. When a phone whose
// hole-punch to its host has failed escalates to `relayThrough: RELAY_KEY`
// (Hyperswarm does this automatically on HOLEPUNCH_ABORTED), both the phone and
// the host dial THIS node and pair their half-connections by a shared token. We
// match them and forward the raw UDX stream between the two.
//
// It is BLIND: the phone<->host stream is Noise-encrypted end to end, so we only
// ever see ciphertext plus metadata (which two keys are talking, byte volume). We
// hold no key to their session and carry no copy of the library - only transient
// encrypted transit. See host/gate.js: the host's firewall still gates admission
// over the relayed connection exactly as over a direct one, so the relay weakens
// neither the grant model nor revoke.
//
// This node MUST live on a routable public IP (a VPS). A box behind home NAT (an
// Umbrel/Start9) is only as reachable as the host we are trying to rescue, which
// defeats the purpose. See the proposal for why.

const HyperDHT = require('hyperdht')
const relay = require('blind-relay')
const z32 = require('z32')

// How much of a public key goes in a log line. Eight z32 characters identify a device to someone
// who already holds the full key, and identify nobody to someone who does not.
const KEY_PREFIX_LEN = 8

function keyPrefix (key) {
  try { return key ? z32.encode(key).slice(0, KEY_PREFIX_LEN) : '?' } catch { return '?' }
}

class RelayNode {
  // opts:
  //   keyPair   - the relay's stable identity. Its publicKey is the constant the
  //               app and host dial. Required.
  //   bootstrap - DHT bootstrap nodes (tests pass a testnet; prod omits for mainline).
  //   dht       - an existing HyperDHT to ride (tests). Otherwise we make our own.
  //   log       - (event, fields) sink. Defaults to silent.
  constructor ({ keyPair, bootstrap, dht, log = () => {} } = {}) {
    if (!keyPair) throw new Error('RelayNode needs a keyPair')
    this.keyPair = keyPair
    this.log = log
    this._ownDht = !dht
    this.dht = dht || new HyperDHT(bootstrap ? { bootstrap } : {})

    // The blind-relay server. `createStream` allocates a raw UDX stream for each
    // end of a matched pair; blind-relay then `.relayTo()`s bytes between the two.
    this.relay = new relay.Server({
      createStream: (opts) => this.dht.createRawStream(opts)
    })

    this.server = null
    this._sessions = new Set()
    this._closing = null

    // Byte accounting. `_live` holds the raw streams currently being relayed; `_closed` is the
    // running total from streams that have gone. Cumulative bytes = closed + a walk of live, so a
    // stats line is always the truth up to that instant rather than only counting what has ended.
    //
    // WE COUNT WHAT ARRIVES (bytesReceived), on both ends of a pair. The same bytes go straight
    // back out of the other end, so "in" and "out" are the same payload seen twice - summing rx
    // across both links is total unique traffic in both directions, and egress is ~equal to it.
    this._live = new Set()
    this._closed = { bytes: 0, streams: 0 }
    // tokenHex -> the first end of a pairing that has arrived, waiting for its partner. Entries
    // are removed when the pair completes or when the lone stream closes, so it stays small.
    this._pending = new Map()
  }

  // How much has actually been relayed, in bytes. Cheap: `_live` is one entry per active stream
  // (34 on the production node today), and udx exposes the counters as plain getters.
  get relayedBytes () {
    let n = this._closed.bytes
    for (const s of this._live) n += s.bytesReceived || 0
    return n
  }

  get publicKey () { return this.keyPair.publicKey }
  get publicKeyZ () { return z32.encode(this.keyPair.publicKey) }

  // A snapshot of what the relay is doing, for the status log and a future dashboard.
  // All counters are cumulative for the process lifetime; `active`/`pending` are current.
  get stats () {
    const s = this.relay.stats
    return {
      sessions: { active: s.sessions.active, accepted: s.sessions.accepted },
      pairings: { active: s.pairings.active, pending: s.pairings.pending, matched: s.pairings.matched },
      streams: { active: s.streams.active, opened: s.streams.opened, errors: s.streams.errors },
      // Cumulative relayed payload. Until 2026-07-27 the node counted sessions and streams but
      // never BYTES, so "how much does one listener cost us" had to be inferred from the droplet's
      // NIC counters - which also carry the DHT's own chatter and every other process. The minute
      // over minute delta of this number is the relay's real traffic, and the only honest input to
      // a capacity estimate.
      bytes: { relayed: this.relayedBytes }
    }
  }

  async ready () {
    // firewall:() => false - a blind relay is open by construction; it forwards
    // ciphertext for anyone who presents a valid token. The END-TO-END Noise
    // handshake + the HOST's firewall are what actually gate access to a library;
    // the relay is a dumb, untrusted pipe and is designed to be.
    this.server = this.dht.createServer(
      { firewall: () => false },
      (conn) => this._onconnection(conn)
    )
    await this.server.listen(this.keyPair)
    this.log('relay:listening', { publicKey: this.publicKeyZ })
    return this
  }

  _onconnection (conn) {
    // A peer vanishing mid-relay is normal, not an error we act on.
    conn.on('error', () => {})

    // Accept the blind-relay protocol on this connection. `id` MUST be the remote
    // peer's own public key: the dialing peer opens its Protomux channel keyed by
    // its own key (hyperdht connect.js/server.js: `id: relaySocket.publicKey`), so
    // from our side that is `conn.remotePublicKey`. Mismatch = the channel never
    // opens and no pairing happens.
    const session = this.relay.accept(conn, { id: conn.remotePublicKey })
    this._sessions.add(session)
    session.on('error', () => {})
    session.on('close', () => this._sessions.delete(session))

    // WHO IS TALKING TO WHOM, AND HOW MUCH - the two facts the README already tells users this
    // relay can see ("it can see that your device is talking to your host and how much data moves,
    // but never the contents"). Logging them does not widen what the relay knows; it writes down
    // what it necessarily handles, so an operator can answer "whose are these sessions" and "what
    // does a listener cost" instead of guessing from a NIC counter.
    //
    // PREFIXES ONLY, never a whole key. Eight z32 characters are enough to recognise a device you
    // already own (Settings > Device key shows the full string, and a host key is printed at boot)
    // and are not a directory of everyone who has ever used the relay. Nothing is written to disk
    // by us - this goes to stdout, so retention is journald's, not ours.
    // NB the `id` blind-relay hands us in the pair event is the UDX STREAM id, a number - not a
    // public key. The only thing tying the two ends of a pairing together here is the shared TOKEN,
    // so we correlate on it in memory and name both peers once the second end arrives. The token
    // itself is a pairing secret and is NEVER logged; it is a Map key and nothing else.
    const self = keyPrefix(conn.remotePublicKey)
    session.on('pair', (isInitiator, token, stream) => {
      const key = token.toString('hex')
      const openedAt = Date.now()
      const waiting = this._pending.get(key)
      if (waiting) {
        this._pending.delete(key)
        this.log('relay:pair', { a: waiting.peer, b: self })
      } else {
        this._pending.set(key, { peer: self, at: openedAt })
      }

      this._live.add(stream)
      stream.on('close', () => {
        const bytes = stream.bytesReceived || 0
        this._live.delete(stream)
        this._closed.bytes += bytes
        this._closed.streams++
        // A half-open pairing whose partner never showed must not sit in the map forever.
        if (this._pending.get(key)?.peer === self) this._pending.delete(key)
        this.log('relay:unpair', { self, ms: Date.now() - openedAt, bytes })
      })
    })
  }

  async close () {
    if (this._closing) return this._closing
    this._closing = (async () => {
      // Close the relay first (ends sessions + tears down live links), then the
      // DHT server, then the node if we own it.
      try { await this.relay.close() } catch {}
      try { if (this.server) await this.server.close() } catch {}
      if (this._ownDht) { try { await this.dht.destroy() } catch {} }
      this.log('relay:closed', {})
    })()
    return this._closing
  }
}

module.exports = { RelayNode }
