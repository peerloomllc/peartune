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
const { decide, sweepKills, Connections } = require('./gate')
const { Presence } = require('./presence')
const { AvatarStore } = require('./avatars')

// How often to sweep live connections for an expired guest grant. `decide()` covers
// connect; this covers a guest that expires WHILE connected. 30s is fine for a scheduled
// expiry - unlike revoke's instant, event-driven kill, nobody is racing a lost phone here.
const EXPIRY_SWEEP_MS = 30_000

// How long a play session stays believable on the dashboard with no heartbeat (listDevices).
const SESSION_STALE_MS = 15 * 60 * 1000
const { serveMedia } = require('./media')
const { PairSession } = require('./pair')
const { SourceStore, buildAdapter } = require('./source')
const { pruneRocksLogs } = require('./logprune')
const { PAIR_PROTOCOL, MEDIA_PROTOCOL } = require('../protocol/constants')

// Keep this many of RocksDB's rotated info logs (store/db/LOG.old.*) for debugging; prune the
// rest. RocksDB rotates them only on reopen, so pruning at startup keeps the count bounded; the
// 12h re-prune is cheap insurance. See host/logprune.js. NOT data - the .sst/.log/MANIFEST are
// never touched.
const ROCKS_LOG_KEEP = 3
const ROCKS_LOG_PRUNE_MS = 12 * 60 * 60_000

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

    // The registry that lets a session.claim on one device's connection push "you lost the
    // token" to another device's connection (host/presence.js). Only ever holds channels the
    // firewall already admitted; a revoke destroys the connection, which unregisters here.
    this.presence = new Presence()

    // Device avatars (a photo the user sets on their phone, sent over the identity
    // channel). Files in the data dir, keyed by deviceKey - see host/avatars.js.
    this.avatars = new AvatarStore(path.join(this.dataDir, 'avatars'))

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
  // A read-modify-write settings file { name, rescanIntervalMin }, so setting one
  // never clobbers the other.
  _settingsFile () { return path.join(this.dataDir, 'library.json') }
  _readSettings () {
    try { return JSON.parse(fs.readFileSync(this._settingsFile(), 'utf8')) || {} } catch { return {} }
  }
  _writeSettings (patch) {
    const next = { ...this._readSettings(), ...patch }
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(this._settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 })
    return next
  }
  _readLibraryName () { return this._readSettings().name || null }
  setLibraryName (name) {
    const clean = String(name == null ? '' : name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64)
    if (!clean) throw new Error('library name required')
    const changed = clean !== this.libraryName
    this._writeSettings({ name: clean })
    this.libraryName = clean
    // Tell every connected device NOW, so its header / switcher / merged chip relabels instantly
    // instead of only on its next reconnect or identity poll. Rides the existing media push channel
    // (host/presence.js); self-describing (carries libraryId) so a device updates the RIGHT host
    // record - it works for a non-active pool host exactly as for the active one. identity.get still
    // carries the current name, so a device offline during the rename catches up on its next connect.
    if (changed) this.presence.notifyAll('library-renamed', { libraryId: this.libraryId, libraryName: clean })
    return clean
  }

  // Scheduled auto-rescan. 0 = off. Mostly for the FOLDER source: files dropped on
  // the NAS appear without a manual Rescan (Navidrome/Jellyfin watch their own
  // libraries, so for them the timer is just a periodic stats refresh). Coarse
  // choices - a short interval re-parses every tag, real work on a big library.
  getRescanIntervalMin () { return Number(this._readSettings().rescanIntervalMin) || 0 }
  setRescanIntervalMin (min) {
    const n = Math.max(0, Math.min(1440, Math.round(Number(min) || 0)))
    this._writeSettings({ rescanIntervalMin: n })
    this._armRescan(n)
    return n
  }
  _armRescan (min = this.getRescanIntervalMin()) {
    if (this._rescanTimer) { clearInterval(this._rescanTimer); this._rescanTimer = null }
    if (min > 0) {
      this._rescanTimer = setInterval(() => {
        this.rescan().catch(e => this.log('host:auto-rescan-failed', { err: e.message }))
      }, min * 60000)
      this._rescanTimer.unref?.() // a background timer must not keep the process alive
    }
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

    // Arm the scheduled auto-rescan from the persisted setting (a no-op when off).
    this._armRescan()

    this.server = this.dht.createServer({
      firewall: (remotePublicKey) => this._firewall(remotePublicKey)
    }, (conn) => this._onconnection(conn))

    await this.server.listen(this.identity.keyPair)

    // Cut guest connections whose grant has expired since they dialed in (see
    // EXPIRY_SWEEP_MS). unref so it never keeps the process alive on its own.
    this._sweep = setInterval(() => { this._sweepExpired().catch(() => {}) }, EXPIRY_SWEEP_MS)
    if (this._sweep.unref) this._sweep.unref()

    // Prune RocksDB's rotated info logs (LOG.old.*) - once now (clears what prior restarts
    // left), then periodically. unref'd, same as the sweep.
    this._pruneRocksLogs()
    this._logPrune = setInterval(() => this._pruneRocksLogs(), ROCKS_LOG_PRUNE_MS)
    if (this._logPrune.unref) this._logPrune.unref()

    this.log('host:listening', {
      hostKey: z32.encode(this.identity.publicKey),
      libraryId: this.libraryId
    })

    return this
  }

  // Delete all but the most-recent RocksDB info logs (store/db/LOG.old.*) so they do not
  // grow without bound. Safe: only LOG.old.* is ever touched - no data, no WAL, no MANIFEST.
  _pruneRocksLogs () {
    const deleted = pruneRocksLogs(path.join(this.dataDir, 'store', 'db'), ROCKS_LOG_KEEP)
    if (deleted) this.log('host:log-pruned', { deleted, kept: ROCKS_LOG_KEEP })
  }

  // Walk the live-connection devices and kill any whose grant decide() now refuses -
  // an expired guest, mostly (a revoke already killed on its own event). Loads each
  // lookup, then delegates the selection to the pure gate.sweepKills.
  async _sweepExpired () {
    const keys = this.connections.deviceKeys()
    if (!keys.length) return
    const lookups = new Map()
    for (const key of keys) lookups.set(key, await this.grants.lookup(key))
    for (const key of sweepKills(keys, lookups)) {
      const killed = this.connections.kill(key)
      this.log('host:expired', { device: key.slice(0, 8), killed })
    }
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
        // A getter too: the operator can rename the library mid-connection, and identity.get
        // (refreshed on every connect) hands the CURRENT name back so the phone updates live.
        libraryName: () => this.libraryName,
        grant: lookup.grant,
        // The host-as-hub user-state store. serveMedia derives the owner from THIS
        // connection's grant, so a device can only ever read/write its own state.
        state: this.userState,
        // Passed so a device can name ITSELF (identity.set). The row it may write
        // is fixed by `grant`, which came from the Noise-authenticated key of this
        // very connection - see host/grants.js setIdentity.
        grants: this.grants,
        // So a session.claim here can push "you were superseded" to the device that
        // held the token (cross-device handoff, instant presence).
        presence: this.presence,
        // device.leave: the phone removed this library, so drop ITS OWN grant + cut the
        // connection (proposal 2026-07-20). Bound here so serveMedia never holds the host.
        onLeave: (deviceKey) => this.leaveDevice(deviceKey),
        // A device sets its own avatar (identity.avatar), keyed by this connection's
        // Noise-authenticated deviceKey - it can only ever write its own.
        avatars: this.avatars,
        log: (msg, data) => this.log(msg, { device: short, ...data })
      })
    })
  }

  // --- operator actions (the dashboard drives these) -----------------------

  // expiresMs > 0 opens a GUEST window: devices that pair through it get access that
  // expires that many ms after pairing. Omitted / null = a normal permanent window.
  startPairing ({ expiresMs = null } = {}) {
    // A window is already open. If its GUEST-ness matches what was asked, reuse it;
    // otherwise close it and open the requested kind, so "Guest pass" never silently
    // hands back a permanent window (or vice versa).
    if (this.pairing) {
      const openMs = this.pairSession.expiresMs || null
      if ((openMs ? 1 : 0) === (expiresMs ? 1 : 0)) return this.pairSession.link
      this.pairSession.close('operator')
    }

    this.pairSession = new PairSession({
      identity: this.identity,
      grants: this.grants,
      libraryName: this.libraryName,
      expiresMs: expiresMs && expiresMs > 0 ? expiresMs : null,
      log: this.log
    })
    this.log('pair:open', { ttlMs: this.pairSession.ttl, guest: !!this.pairSession.expiresMs })
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
    const row = await this.grants.revoke(deviceKey, { by: 'operator' })
    const killed = this.connections.kill(deviceKey)
    this.log('host:revoked', {
      device: Grants.keyOf(deviceKey).slice(0, 8),
      killedConnections: killed
    })
    return { grant: row, killed }
  }

  // A device dropping its OWN access - the phone removed this library / unpaired (device.leave,
  // proposal 2026-07-20). Same teeth as an operator revoke (tombstone + cut every live connection
  // it holds) so "remove" on the phone actually ends access here instead of leaving a live grant,
  // but logged as a self-initiated leave. The deviceKey is the leaving connection's own Noise-
  // authenticated key (media.js passes grant.deviceKey), so a device can only ever leave on its
  // own behalf. The revoked row is hidden by the dashboard's "show revoked" toggle, so the device
  // drops out of the default Devices list.
  async leaveDevice (deviceKey) {
    // 'self': the DEVICE ended this, not the operator - so pairing again may bring it back
    // to the person it held (gate.carryOverPerson). An operator revoke never does.
    const row = await this.grants.revoke(deviceKey, { by: 'self' })
    const killed = this.connections.kill(deviceKey)
    this.log('host:device-left', {
      device: Grants.keyOf(deviceKey).slice(0, 8),
      killedConnections: killed
    })
    return { grant: row, killed }
  }

  // Edit a device's guest expiry from the dashboard: a timestamp to (re)limit it, or null
  // to promote it to permanent. The sweep enforces a future expiry; if the operator sets
  // one already in the past we cut the connection now rather than waiting up to 30s.
  async setDeviceExpiry (deviceKey, expiresAt) {
    const row = await this.grants.setExpiry(deviceKey, expiresAt)
    if (!row) return { grant: null, killed: 0 }
    const killed = (expiresAt && Date.now() > expiresAt) ? this.connections.kill(deviceKey) : 0
    this.log('host:expiry-set', { device: Grants.keyOf(deviceKey).slice(0, 8), expiresAt, killed })
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
    this.avatars.delete(deviceKey) // don't orphan the photo file
    const killed = this.connections.kill(deviceKey)
    this.log('host:device-deleted', { device: Grants.keyOf(deviceKey).slice(0, 8), killed })
    return { deleted: row, killed }
  }

  // Remove an empty person (grants.deletePerson refuses one that still holds a live
  // device). Nothing to kill: their live devices, if any, are what would have blocked
  // the delete.
  //
  // Deleting the person ALSO purges their user state, because the personId is minted
  // fresh and never reused - so those favorites, resume points, counts and playlists
  // become unreachable the moment the row goes. Leaving them was a slow leak and a
  // privacy wart ("delete Ben" that did not delete Ben's history). Order matters: the
  // person row goes FIRST, since that is the guarded step that can refuse.
  async deletePerson (personId) {
    const person = await this.grants.deletePerson(personId)
    if (!person) return { deleted: null }
    const purged = await this.userState.deleteOwner('p:' + personId)
    this.log('host:person-deleted', { personId, purged })
    return { deleted: person, purged }
  }

  async listDevices () {
    // A session the phone has not touched in this long is not what it is doing NOW. The
    // heartbeat rides the play-status tick (a few seconds apart while playing) and is forced
    // on every structural change, so a LIVE session is never this old - a row this stale is a
    // leftover from a phone that moved its session to another host or simply stopped. The cost
    // is that a phone left paused for a long time eventually drops off the dashboard, which is
    // the right trade against announcing a track from three days ago as "now playing".
    const fresh = (s) => Date.now() - (s.updatedAt || 0) < SESSION_STALE_MS
    const rows = await this.grants.list()
    // The play session is per OWNER (a person, or an unclaimed device is its own
    // owner) and names ONE activeDeviceKey - only that device is playing. Load each
    // owner's session once, then attach now-playing to the device that holds it; every
    // other device is idle. Best-effort: a session read failing just omits the track.
    //
    // Read BOTH session rows and take the fresher one. A phone in MERGED mode writes to
    // `session:merged:{owner}` on the elected home host and never touches the single-library
    // row again - so reading only the single row showed nothing at all on the home host, and
    // showed the last single-library session FOREVER on every other host. Tim saw exactly
    // that: the Mac (the merged home) had no now-playing on any row, while the Umbrel proudly
    // displayed a track from days earlier.
    const sessions = new Map()
    const sessionFor = async (ownerId) => {
      if (!sessions.has(ownerId)) {
        const [single, merged] = await Promise.all([
          this.userState.getSession(ownerId).catch(() => null),
          this.userState.getSession(ownerId, true).catch(() => null)
        ])
        const fresher = (merged?.updatedAt || 0) >= (single?.updatedAt || 0) ? merged : single
        sessions.set(ownerId, fresher)
      }
      return sessions.get(ownerId)
    }
    return Promise.all(rows.map(async r => {
      const online = this.connections.count(r.deviceKey) > 0
      let nowPlaying = null
      if (online && !r.revokedAt) {
        const s = await sessionFor(r.personId ? 'p:' + r.personId : 'd:' + r.deviceKey)
        if (s && s.activeDeviceKey === r.deviceKey && Array.isArray(s.queue) && s.queue.length && fresh(s)) {
          const t = s.queue[s.index] || s.queue[0]
          if (t) {
            // The session carries the phone's own loopback art URL, useless here, but
            // it has the trackId - resolve its coverId once (cached; covers are stable
            // per id) so the dashboard can load a thumbnail off /api/art without a
            // per-poll source lookup (matters for the network-backed adapters).
            nowPlaying = { title: t.title || null, artist: t.artist || null, playing: !!s.playing, coverId: await this._coverIdFor(t.trackId) }
          }
        }
      }
      return { ...r, online, nowPlaying, hasAvatar: this.avatars.has(r.deviceKey), avatarAt: this.avatars.at(r.deviceKey) }
    }))
  }

  // trackId -> coverId, cached: a track's cover is stable, so a network-backed source
  // (Subsonic/Jellyfin) is asked at most once per track rather than every 3s poll.
  async _coverIdFor (trackId) {
    if (!trackId || !this.adapter) return null
    if (!this._coverIdCache) this._coverIdCache = new Map()
    if (this._coverIdCache.has(trackId)) return this._coverIdCache.get(trackId)
    const t = await this.adapter.get({ id: trackId }).catch(() => null)
    const coverId = t?.coverId || null
    this._coverIdCache.set(trackId, coverId)
    return coverId
  }

  async close () {
    this.stopPairing()
    if (this._sweep) clearInterval(this._sweep)
    if (this._logPrune) clearInterval(this._logPrune)
    if (this._rescanTimer) clearInterval(this._rescanTimer)
    if (this.server) await this.server.close()
    await this.bee.close()
    await this.stateBee.close()
    await this.store.close()
    if (this._ownDht) await this.dht.destroy()
    this.log('host:closed')
  }
}

module.exports = { PearTuneHost }
