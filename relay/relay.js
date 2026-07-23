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
      streams: { active: s.streams.active, opened: s.streams.opened, errors: s.streams.errors }
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
