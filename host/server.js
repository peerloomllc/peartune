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
const fs = require('fs')
const HyperDHT = require('hyperdht')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Protomux = require('protomux')
const b4a = require('b4a')
const z32 = require('z32')

const { createIdentity } = require('./identity')
const { Grants } = require('./grants')
const { UserState } = require('./state')
const { decide, Connections } = require('./gate')
const { serveMedia } = require('./media')
const { PairSession } = require('./pair')
const { SourceStore, buildAdapter } = require('./source')
const { PAIR_PROTOCOL, MEDIA_PROTOCOL } = require('../protocol/constants')

class PearTuneHost {
  constructor ({ dataDir, musicDir, libraryName = 'My Library', subsonic = null, dht = null, bootstrap = null, log = () => {} }) {
    this.dataDir = path.resolve(dataDir)
    this.musicDir = musicDir
    // A persisted operator rename (library.json) wins over the env/CLI default, so the
    // name set in the dashboard survives a restart even though PEARTUNE_NAME is still
    // set - the same precedence the source config uses (host/source.js).
    this.libraryName = this._readLibraryName() || libraryName
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

    // User state (favorites, later resume/counts/playlists) - HOST-AS-HUB, milestone 3.
    // A SEPARATE Hyperbee from grants, on purpose: grants are a single-purpose,
    // never-replicated security surface, and user state should not share that store or
    // its rules. Both live in the one corestore.
    this.stateBee = new Hyperbee(this.store.get({ name: 'state' }), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    this.userState = new UserState(this.stateBee)

    this.connections = new Connections()

    // One interface, two implementations. The app never learns which is behind the
    // media API, which is what keeps the raw-folder path a first-class citizen
    // instead of a fallback nobody tests.
    //
    // WHICH one is now the OPERATOR's choice (source.json), not the container's
    // (env vars) - see host/source.js. Somebody installing this from an app store is
    // never going to hand-edit a compose file, and without Navidrome they would get a
    // library of filenames.
    //
    // ONE CONFIG PER KIND (host/source.js). Switching Navidrome -> Folder no longer
    // throws the Navidrome credentials away; `active` is a pointer, and every kind
    // keeps its own row.
    this.sources = new SourceStore({
      dataDir: this.dataDir,
      // The env/CLI credential blob (PEARTUNE_NAVIDROME_* / --navidrome) now builds a
      // 'subsonic'-kind source. The env var NAMES are kept - people have them set.
      env: subsonic ? { subsonic } : null,
      musicDir: this.musicDir
    })
    this.source = this.sources.active()
    this.adapter = this._build(this.source)
    this.sourceError = null
    this.server = null
    this.pairSession = null
  }

  get publicKey () {
    return this.identity.publicKey
  }

  _build (cfg) {
    return buildAdapter(cfg, {
      libraryId: this.libraryId,
      musicDir: this.musicDir,
      log: this.log
    })
  }

  // Change where the music comes from, live, without a restart.
  //
  // The adapter is swapped ATOMICALLY and only after the new one has scanned: if the
  // Navidrome credentials are wrong, this throws and the old source is still serving.
  // A library that goes dark because someone mistyped a password is not an acceptable
  // way to find out you mistyped a password.
  async setSource (cfg) {
    cfg = this.sources.withKeptSecrets(cfg)
    const next = this._build(cfg)
    const tracks = await next.scan() // throws on a bad URL, bad credentials, no folder

    this.adapter = next
    this.sources.save(cfg)
    this.source = this.sources.active()
    this.sourceError = null

    const st = await next.stats().catch(() => ({}))
    this.log('host:source-changed', { source: cfg.kind, tracks })
    return { kind: cfg.kind, tracks, albums: st.albums ?? 0, artists: st.artists ?? 0 }
  }

  // Does this config actually work? Used by the dashboard's "Test" button, so an
  // operator finds out BEFORE committing to it - and it never touches the live
  // adapter.
  //
  // probe() rather than scan(): testing a FOLDER should not parse the tags of ten
  // thousand files to answer "yes, that folder exists and has music in it". The
  // adapters each know the cheapest way to prove they work.
  async testSource (cfg) {
    cfg = this.sources.withKeptSecrets(cfg)
    return { ok: true, kind: cfg.kind, ...(await this._build(cfg).probe()) }
  }

  // Re-read the source. A FOLDER has no scanner watching it: copy an album onto the
  // NAS and the host does not know until somebody says so. (Navidrome and Jellyfin
  // watch their own libraries, so for them this is just a refresh.)
  async rescan () {
    const tracks = await this.adapter.scan()
    this.sourceError = null
    const st = await this.adapter.stats().catch(() => ({}))
    this.log('host:rescanned', { source: this.adapter.kind, tracks })
    return { kind: this.adapter.kind, tracks, albums: st.albums ?? 0, artists: st.artists ?? 0 }
  }

  // The operator's library name. Persisted to library.json in the data dir so it
  // survives a restart (mirrors host/source.js). Sanitised the same way device/person
  // names are (trim, cap 64, strip control chars) - it is shown on the dashboard and
  // sent to a pairing device.
  _libraryFile () { return path.join(this.dataDir, 'library.json') }
  _readLibraryName () {
    try { return JSON.parse(fs.readFileSync(this._libraryFile(), 'utf8')).name || null } catch { return null }
  }
  setLibraryName (name) {
    const clean = String(name == null ? '' : name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64)
    if (!clean) throw new Error('library name required')
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(this._libraryFile(), JSON.stringify({ name: clean }, null, 2))
    this.libraryName = clean
    return clean
  }

  get sourceView () {
    return this.sources.view()
  }

  get pairing () {
    return !!(this.pairSession && !this.pairSession.closed)
  }

  async ready () {
    await this.bee.ready()
    await this.stateBee.ready()

    // A BAD SOURCE MUST NOT STOP THE HOST FROM STARTING.
    //
    // If the saved Navidrome credentials are wrong (someone rotated the password,
    // the container moved), scan() throws - and if that killed the process, the
    // operator would be locked out of the very dashboard they need in order to fix
    // it. So: come up, serve the dashboard, and say what is wrong.
    try {
      const n = await this.adapter.scan()
      this.log('host:scanned', { source: this.adapter.kind, tracks: n })
    } catch (e) {
      this.sourceError = e.message
      this.log('host:source-failed', { source: this.adapter.kind, err: e.message })
    }

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
        // A GETTER, not the adapter itself. A connection outlives a source change,
        // and a phone that keeps streaming from the source you just switched away
        // from is a bug you would not find for weeks.
        getAdapter: () => this.adapter,
        grant: lookup.grant,
        // The host-as-hub user-state store. serveMedia derives the owner from THIS
        // connection's grant, so a device can only ever read/write its own state.
        state: this.userState,
        // Passed so a device can name ITSELF (identity.set). The row it may write
        // is fixed by `grant`, which came from the Noise-authenticated key of this
        // very connection - see host/grants.js setIdentity.
        grants: this.grants,
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

  // Cleanup, not revocation. Removes a REVOKED device's tombstone so the Devices list
  // stops growing forever; grants.deleteGrant refuses a live grant, so the operator has
  // to revoke first (which tombstones and cuts the connection). We kill any lingering
  // connection here too, belt-and-braces: a revoked device should have none, but a
  // delete must never leave one half-alive, and it can never re-admit - with the row
  // gone the gate denies by default (gate.js).
  async deleteDevice (deviceKey) {
    const row = await this.grants.deleteGrant(deviceKey)
    if (!row) return { deleted: null, killed: 0 }
    const killed = this.connections.kill(deviceKey)
    this.log('host:device-deleted', { device: Grants.keyOf(deviceKey).slice(0, 8), killed })
    return { deleted: row, killed }
  }

  // Remove an empty person (grants.deletePerson refuses one that still holds a live
  // device). Nothing to kill: their live devices, if any, are what would have blocked
  // the delete.
  async deletePerson (personId) {
    const person = await this.grants.deletePerson(personId)
    if (!person) return { deleted: null }
    this.log('host:person-deleted', { personId })
    return { deleted: person }
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
    await this.stateBee.close()
    await this.store.close()
    if (this._ownDht) await this.dht.destroy()
    this.log('host:closed')
  }
}

module.exports = { PearTuneHost }
