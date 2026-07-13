// The PearTune host.
//
// Runs on the machine that holds the music. ONE HyperDHT server, listening on
// the host keypair. Granted devices get the media API; a device with no grant is
// refused outright, unless a pairing window is open, in which case it gets the
// pairing channel and nothing else.
//
// One server, one identity. An earlier cut also ran a Hyperswarm for a pairing
// rendezvous, which quietly created a SECOND dht server on the same keypair and
// deadlocked. See host/pair.js for why the rendezvous was unnecessary here.

const path = require('path')
const HyperDHT = require('hyperdht')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Protomux = require('protomux')
const b4a = require('b4a')
const z32 = require('z32')

const { createIdentity } = require('./identity')
const { Grants } = require('./grants')
const { decide, Connections } = require('./gate')
const { serveMedia } = require('./media')
const { PairSession } = require('./pair')
const { FolderAdapter } = require('./adapters/folder')
const { PAIR_PROTOCOL, MEDIA_PROTOCOL } = require('../protocol/constants')

class PearTuneHost {
  constructor ({ dataDir, musicDir, libraryName = 'My Library', dht = null, bootstrap = null, log = () => {} }) {
    this.dataDir = path.resolve(dataDir)
    this.musicDir = musicDir
    this.libraryName = libraryName
    this.log = log

    this.identity = createIdentity(this.dataDir)
    this.libraryId = this.identity.libraryId

    this._ownDht = !dht
    this.dht = dht || new HyperDHT(bootstrap ? { bootstrap } : {})

    this.store = new Corestore(path.join(this.dataDir, 'store'))
    this.bee = new Hyperbee(this.store.get({ name: 'grants' }), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    this.grants = new Grants(this.bee)
    this.connections = new Connections()

    this.adapter = new FolderAdapter({ root: musicDir, libraryId: this.libraryId })
    this.server = null
    this.pairSession = null
  }

  get publicKey () {
    return this.identity.publicKey
  }

  get pairing () {
    return !!(this.pairSession && !this.pairSession.closed)
  }

  async ready () {
    await this.bee.ready()
    const n = await this.adapter.scan()
    this.log('host:scanned', { tracks: n, root: this.musicDir })

    this.server = this.dht.createServer({
      firewall: (remotePublicKey) => this._firewall(remotePublicKey)
    }, (conn) => this._onconnection(conn))

    await this.server.listen(this.identity.keyPair)

    this.log('host:listening', {
      hostKey: z32.encode(this.identity.publicKey),
      libraryId: this.libraryId
    })

    return this
  }

  // HyperDHT awaits this hook, so touching the Hyperbee here is fine. It also
  // initialises `firewalled: true` and SWALLOWS a throw, so any error in this
  // path fails CLOSED (denied). test/gate.test.js pins that behavior, because a
  // future hyperdht bump that flipped it to fail-open would silently expose
  // every library in the wild.
  //
  // Returns TRUE to DENY.
  async _firewall (remotePublicKey) {
    const short = z32.encode(remotePublicKey).slice(0, 8)

    const lookup = await this.grants.lookup(remotePublicKey)
    const { allow, reason } = decide(lookup)

    if (allow) {
      this.log('gate:allow', { device: short, reason })
      return false
    }

    // Chicken-and-egg: a device that has never paired HAS no grant, so the gate
    // must let it in far enough to pair. It is admitted only while the operator
    // has a window open, and _onconnection gives it the pairing channel ONLY -
    // never the media API. It still has to present the QR token to get a grant.
    if (this.pairing) {
      this.log('gate:allow-for-pairing', { device: short })
      return false
    }

    this.log('gate:deny', { device: short, reason })
    return true
  }

  // SYNCHRONOUS on purpose, and it registers Protomux `pair` handlers rather
  // than creating channels directly.
  //
  // This is the second time this exact bug has bitten the suite (see the
  // @peerloom/core writer-admission fix). Protomux REJECTS a channel the remote
  // opens if we have not created our side yet AND no `mux.pair` notify handler
  // is registered for that (protocol, id) - see `_requestSession` in
  // protomux/index.js. The client dials and opens its channel immediately, so
  // any `await` before we set our side up (a Hyperbee grant lookup, say) loses
  // the race and the connection dies for no visible reason.
  //
  // `mux.pair` is the supported way to say "I will build my side when you ask
  // for it". Protomux awaits the callback, so the async grant lookup is fine
  // INSIDE it - just not before it.
  _onconnection (conn) {
    const remoteKey = conn.remotePublicKey
    const short = z32.encode(remoteKey).slice(0, 8)
    const id = b4a.from(this.libraryId)

    conn.on('error', () => {}) // a peer vanishing is normal, not an event

    // Registered even while unpaired, so a revoke landing mid-pair can still
    // find and kill the connection.
    this.connections.add(remoteKey, conn)

    const mux = Protomux.from(conn)

    mux.pair({ protocol: PAIR_PROTOCOL, id }, () => {
      // The window may have closed between the firewall admitting this device
      // and it asking to pair. A race must never become an admission.
      if (!this.pairing) {
        this.log('host:pair-window-closed', { device: short })
        conn.destroy()
        return
      }
      this.log('host:pairing-connection', { device: short })
      this.pairSession.serve(conn)
    })

    mux.pair({ protocol: MEDIA_PROTOCOL, id }, async () => {
      const lookup = await this.grants.lookup(remoteKey)
      const { allow, reason } = decide(lookup)

      // The firewall let this device through, but that may have been the
      // pairing exemption. Reaching the MEDIA api requires a real grant.
      if (!allow) {
        this.log('host:media-denied', { device: short, reason })
        conn.destroy()
        return
      }

      await this.grants.touch(remoteKey)
      this.log('host:connected', { device: short, live: this.connections.size })

      serveMedia({
        conn,
        libraryId: this.libraryId,
        adapter: this.adapter,
        grant: lookup.grant,
        log: (msg, data) => this.log(msg, { device: short, ...data })
      })
    })
  }

  // --- operator actions (the dashboard drives these) -----------------------

  startPairing () {
    if (this.pairing) return this.pairSession.link

    this.pairSession = new PairSession({
      identity: this.identity,
      grants: this.grants,
      libraryName: this.libraryName,
      log: this.log
    })
    this.log('pair:open', { ttlMs: this.pairSession.ttl })
    return this.pairSession.link
  }

  stopPairing () {
    if (this.pairSession) this.pairSession.close('operator')
  }

  // The teeth. Tombstoning the grant only stops the NEXT connection; the firewall
  // hook never runs again for one already open. Killing the live connections is
  // what makes revoke mean "the music stops now" instead of "the music stops
  // whenever they happen to reconnect".
  async revokeDevice (deviceKey) {
    const row = await this.grants.revoke(deviceKey)
    const killed = this.connections.kill(deviceKey)
    this.log('host:revoked', {
      device: Grants.keyOf(deviceKey).slice(0, 8),
      killedConnections: killed
    })
    return { grant: row, killed }
  }

  async revokePerson (personId) {
    const revoked = await this.grants.revokePerson(personId)
    const killed = this.connections.killAll(revoked.map(r => r.deviceKey))
    this.log('host:revoked-person', { personId, devices: revoked.length, killedConnections: killed })
    return { revoked, killed }
  }

  async listDevices () {
    const rows = await this.grants.list()
    return rows.map(r => ({
      ...r,
      online: this.connections.count(r.deviceKey) > 0
    }))
  }

  async close () {
    this.stopPairing()
    if (this.server) await this.server.close()
    await this.bee.close()
    await this.store.close()
    if (this._ownDht) await this.dht.destroy()
    this.log('host:closed')
  }
}

module.exports = { PearTuneHost }
