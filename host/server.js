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
//
// PERSISTENT-HYPERSWARM TRANSPORT (proposal 2026-07-22, phase 1). On top of the
// server above, the host ANNOUNCES a discovery topic derived from its key so a
// phone can find it by DHT lookup and keep retrying until a hole-punch lands
// (the off-LAN fix). Announce is discovery ONLY: the connection still arrives at
// this same server and is gated by the same async firewall, so admission and the
// revoke guarantee are byte-for-byte unchanged, and a raw dht.connect(hostKey)
// from an un-upgraded phone keeps working.
//
// We announce with the RAW DHT rather than standing up a Hyperswarm here, for
// two measured reasons: (1) a Hyperswarm would run its OWN dht server on this
// keypair - the two-servers-on-one-keypair deadlock warned about just above; and
// (2) Hyperswarm's firewall wrapper is synchronous and cannot carry our async
// grant lookup - it bans a peer on the first (Promise-truthy) return, so a
// GRANTED phone's every reconnect is then refused (measured 2026-07-22). So the
// host stays on createServer; only the PHONE gets Hyperswarm's ConnectionManager,
// which is where the retry-forever + keepalive that actually fixes off-LAN lives.
//
// ON @peerloom/host (proposal 2026-08-12-shared-host, option C; migration plan
// proposals/2026-09-17-peartune-host-migration-plan.md). The server, firewall, pairing,
// grants, presence, announce, sweep and every operator action that cuts somebody off
// are LibraryHost's. This class is what is PearTune: music sources, library settings,
// Home Assistant speakers and voice, the request queue and now-playing. It wires those
// in through LibraryHost's hooks and exposes the host's pieces under the names the
// dashboard, index.js and the tests have always used.

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const z32 = require('z32')

const { LibraryHost, Grants, notifyOwners, createProtocol } = require('@peerloom/host')
const { SCOPE } = require('@peerloom/host/constants')
const { createMedia } = require('./media')
const { AvatarStore } = require('./avatars')
const { Speakers, canWriteHaConfig } = require('./speakers')
const { CastSessions } = require('./cast')
const { SourceStore, buildAdapter, buildBooksAdapter, composeAdapter } = require('./source')

// The wire every paired phone already speaks. `peartune` is a DATA identifier, not a
// label: it seeds libraryId and every id derived from it (peerloom-host CLAUDE.md), and
// peerloom-host/test/brand-compat.test.js pins what it must produce.
const PROTOCOL = createProtocol({ app: 'peartune', displayName: 'PearTune' })

// How long a device's own now-playing report stands before we drop it. The phone refreshes it on
// the same ~4s heartbeat that carries the queue, so this is a few missed beats - long enough to
// survive a hiccup, short enough that the row clears on its own within seconds of the phone
// stopping, pausing into silence, or moving to a track ANOTHER library serves. Expiry IS the
// stop signal: there is no "stopped" message to lose.
//
// This replaced a six-minute window over what we last STREAMED (2026-07-28, same day). That guess
// was wrong in the worst way: a phone fetches a track in one request and plays it for minutes
// without asking again, so a host went on reporting the last thing it served - Tim saw two
// dashboards claiming two different songs, both "now playing". A host sees requests, not
// playback; only the phone knows.
const NOWPLAYING_STALE_MS = 20 * 1000

class PearTuneHost {
  constructor ({ dataDir, musicDir, libraryName = 'My Library', subsonic = null, dht = null, bootstrap = null, dhtPort = null, log = () => {} }) {
    this.dataDir = path.resolve(dataDir)
    this.musicDir = musicDir
    this.log = log

    // deviceKey -> { trackId, at }: the last track THIS host served that device. In memory on
    // purpose - it describes right now, not history, and a restart should forget it. One entry per
    // paired device at most, overwritten per request.
    this._streaming = new Map()
    // deviceKey -> { trackId, title, artist, playing, at }: what the DEVICE says it is playing from
    // us. In memory and short-lived on purpose - see NOWPLAYING_STALE_MS.
    this._nowPlaying = new Map()

    this.host = new LibraryHost({
      protocol: PROTOCOL,
      dataDir: this.dataDir,
      // A persisted operator rename (library.json) wins over the env/CLI default, so the
      // name set in the dashboard survives a restart even though PEARTUNE_NAME is still
      // set - the same precedence the source config uses (host/source.js).
      libraryName: this._readLibraryName() || libraryName,
      dht,
      bootstrap,
      // dhtPort pins the DHT's UDP socket, for a router port-forward or StartOS 0.4's
      // bindPortRange (proposals/2026-07-29-start9-bindportrange.md). Unset is a random port.
      dhtPort,
      log,
      // A speaker is NOT one of the connections kill() destroys - the audio reaches it from
      // this process, not from the revoked phone. The package calls this wherever it kills
      // connections (revoke, leave, expiry, delete, person revoke), and sweeps the casting
      // keys too, so a phone that cast and closed its app still expires. See host/cast.js.
      // Lazy: this.casts is built below, after the host it needs.
      silence: (deviceKey) => this.casts ? this.casts.stopFor(deviceKey) : 0,
      extraLiveKeys: () => this.casts ? this.casts.deviceKeys() : [],
      decorateDevice: (row, { online }) => this._decorateDevice(row, online),
      // Don't orphan the photo file.
      onDeviceDeleted: (deviceKey) => this.avatars.delete(deviceKey),
      // Deleting the person ALSO purges their user state, because the personId is minted
      // fresh and never reused - so those favorites, resume points, counts and playlists
      // become unreachable the moment the row goes.
      onPersonDeleted: (personId) => this.host.userState.deleteOwner('p:' + personId),
      media: (host) => createMedia({
        // A GETTER, not the adapter itself. A connection outlives a source change,
        // and a phone that keeps streaming from the source you just switched away
        // from is a bug you would not find for weeks.
        getAdapter: () => this.adapter,
        // A getter too: the operator can rename the library mid-connection, and identity.get
        // (refreshed on every connect) hands the CURRENT name back so the phone updates live.
        libraryName: () => this.libraryName,
        grants: host.grants,
        state: host.userState,
        presence: host.presence,
        avatars: this.avatars,
        // device.leave: the phone removed this library, so drop ITS OWN grant + cut the
        // connection (proposal 2026-07-20).
        onLeave: (deviceKey) => this.leaveDevice(deviceKey),
        // Every served track, per device: what THIS host is actually streaming right now.
        onStream: (deviceKey, trackId) => this._noteStreaming(deviceKey, trackId),
        // The phone's own statement of what it is playing from us (proposal 2026-07-28).
        onNowPlaying: (deviceKey, np) => this._noteNowPlaying(deviceKey, np),
        // Owner maintenance from the app (proposal 2026-07-24, P2). Bound host operations,
        // never the host itself - media.js gates them on grant.scope === 'owner'.
        owner: {
          listDevices: () => this.listDevices(),
          revokeDevice: (deviceKey) => this.revokeDevice(deviceKey),
          getGrant: (deviceKey) => this.grants.get(deviceKey),
          claim: (deviceKey, code) => this.claimOwner(deviceKey, code),
          // P2b: a NORMAL/guest window - never an owner one, so an owner phone can't mint
          // more owners (security review).
          pairStart: ({ expiresMs } = {}) => this.startPairing({ expiresMs, owner: false }),
          pairStop: () => this.stopPairing(),
          pairState: () => ({ pairing: this.pairing, link: this.pairSession && !this.pairSession.closed ? this.pairSession.link : null }),
          requests: () => this.ownerRequestList(),
          resolveRequest: (id, status) => this.resolveRequestAndNotify(id, status)
        },
        // Home Assistant speaker playback (proposal 2026-08-01). media.js gates every one on
        // the grant's scope, because casting makes noise in somebody's house.
        speakers: {
          enabled: () => this.speakers.enabled,
          list: () => this.speakers.list(),
          state: (entityId) => this.speakers.getState(entityId),
          setVolume: (entityId, level) => this.speakers.setVolume(entityId, level),
          pause: (entityId) => this.speakers.pause(entityId),
          resume: (entityId) => this.speakers.resume(entityId),
          // deviceKey is bound from THIS connection's grant by media.js, never a param.
          play: (deviceKey, entityId, trackId) => this.casts.play({ deviceKey, entityId, trackId }),
          stop: (deviceKey, entityId) => this.casts.stop(deviceKey, entityId),
          active: (deviceKey) => this.casts.active(deviceKey)
        }
      })
    })

    // Device avatars (a photo the user sets on their phone, sent over the identity
    // channel). Files in the data dir, keyed by deviceKey - see host/avatars.js.
    this.avatars = new AvatarStore(path.join(this.dataDir, 'avatars'))

    // One interface, several implementations, chosen by the OPERATOR (source.json), not the
    // container's env vars - see host/source.js. One config per kind: switching Navidrome ->
    // Folder keeps the Navidrome credentials; `active` is a pointer.
    this.sources = new SourceStore({
      dataDir: this.dataDir,
      // The env/CLI credential blob (PEARTUNE_NAVIDROME_* / --navidrome) builds a
      // 'subsonic'-kind source. The env var NAMES are kept - people have them set.
      env: subsonic ? { subsonic } : null,
      musicDir: this.musicDir
    })
    this.source = this.sources.active()
    // The library is the music adapter, combined with an Audiobookshelf books source when one
    // is configured (proposal 2026-09-13-audiobookshelf-books-source).
    this.musicAdapter = this._build(this.source)
    const booksCfg = this.sources.books()
    this.booksAdapter = booksCfg ? buildBooksAdapter(booksCfg, { libraryId: this.libraryId, log: this.log }) : null
    this.adapter = composeAdapter(this.musicAdapter, this.booksAdapter, { log: this.log })
    this.sourceError = null

    // Home Assistant speaker playback (proposal 2026-08-01). Both are inert until an
    // operator configures HA in the dashboard.
    this.speakers = new Speakers({ dataDir: this.dataDir, log: this.log })
    this.casts = new CastSessions({
      speakers: this.speakers,
      grants: this.grants,
      getAdapter: () => this.adapter,
      presence: this.presence,
      log: this.log
    })
  }

  // --- the package's pieces, under the names this app has always used ------------

  get identity () { return this.host.identity }
  get libraryId () { return this.host.libraryId }
  get publicKey () { return this.host.publicKey }
  get dht () { return this.host.dht }
  get grants () { return this.host.grants }
  get userState () { return this.host.userState }
  get connections () { return this.host.connections }
  get presence () { return this.host.presence }
  get pairSession () { return this.host.pairSession }
  get pairing () { return this.host.pairing }
  get server () { return this.host.server }
  get _earlyReannounce () { return this.host._earlyReannounce }
  get libraryName () { return this.host.libraryName }
  set libraryName (name) { this.host.libraryName = name }

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

    // The books source (if any) is already scanned and keeps serving across a music swap.
    this.musicAdapter = next
    this.adapter = composeAdapter(next, this.booksAdapter, { log: this.log })
    this.sources.save(cfg)
    this.source = this.sources.active()
    this.sourceError = null

    const st = await next.stats().catch(() => ({}))
    this.log('host:source-changed', { source: cfg.kind, tracks })
    // Every id a connected phone holds just went stale (trackIds are source-scoped by
    // design - the dashboard warns on swap). Tell every live connection so the app can
    // drop its cached index and reload, instead of asking the new source for an old id
    // and painting "internal error" (Tim, 2026-08-17). Additive: an old client ignores
    // unknown push kinds.
    this.presence.notifyAll('library:changed', { libraryId: this.libraryId, source: cfg.kind })
    return { kind: cfg.kind, tracks, albums: st.albums ?? 0, artists: st.artists ?? 0, books: st.books ?? 0 }
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
    return { kind: this.adapter.kind, tracks, albums: st.albums ?? 0, artists: st.artists ?? 0, books: st.books ?? 0 }
  }

  // --- the Audiobookshelf books source (proposal 2026-09-13) -------------------
  //
  // Same contract as setSource: build, scan, and only then swap and save, so a wrong key
  // leaves whatever was serving untouched and the dashboard shows why.

  async testBooks (cfg) {
    cfg = this.sources.booksWithKeptSecrets({ kind: 'audiobookshelf', ...cfg })
    const abs = buildBooksAdapter(cfg, { libraryId: this.libraryId, log: this.log })
    return { ok: true, ...(await abs.probe()) }
  }

  async setBooks (cfg) {
    cfg = this.sources.booksWithKeptSecrets({ kind: 'audiobookshelf', ...cfg })
    if (!cfg.url) throw new Error('an Audiobookshelf address is needed')
    const abs = buildBooksAdapter(cfg, { libraryId: this.libraryId, log: this.log })
    const tracks = await abs.scan()
    this.booksAdapter = abs
    this.adapter = composeAdapter(this.musicAdapter, abs, { log: this.log })
    this.sources.saveBooks(cfg)
    const st = await abs.stats()
    this.log('host:books-source-changed', { books: st.books, tracks })
    this.presence.notifyAll('library:changed', { libraryId: this.libraryId, source: this.adapter.kind })
    return { books: st.books, tracks }
  }

  async removeBooks () {
    this.booksAdapter = null
    this.adapter = this.musicAdapter
    this.sources.removeBooks()
    this.log('host:books-source-removed')
    this.presence.notifyAll('library:changed', { libraryId: this.libraryId, source: this.adapter.kind })
    return { ok: true }
  }

  // For the dashboard: the saved address and login shape (no secrets), and how the last
  // scan went.
  async booksStatus () {
    const view = this.sources.booksView()
    if (!view || !this.booksAdapter) return null
    const st = await this.booksAdapter.stats().catch(() => null)
    return {
      ...view,
      books: st ? st.books : 0,
      tracks: st ? st.tracks : 0,
      error: this.adapter.booksError || null,
      scannedAt: st ? st.scannedAt : null
    }
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

  async ready () {
    // A BAD SOURCE MUST NOT STOP THE HOST FROM STARTING.
    //
    // If the saved Navidrome credentials are wrong (someone rotated the password,
    // the container moved), scan() throws - and if that killed the process, the
    // operator would be locked out of the very dashboard they need in order to fix
    // it. So: come up, serve the dashboard, and say what is wrong.
    //
    // Scanned BEFORE the host listens, as it always was, so a phone never sees an
    // unscanned library.
    try {
      const n = await this.adapter.scan()
      this.log('host:scanned', { source: this.adapter.kind, tracks: n })
    } catch (e) {
      this.sourceError = e.message
      this.log('host:source-failed', { source: this.adapter.kind, err: e.message })
    }

    // Voice control listens on the cast server, so it has to be up from the start rather
    // than lazily on the first cast - otherwise a spoken request after a restart hits a
    // closed port. Only when voice is actually on; casting alone still starts it lazily.
    if (this.speakers.config?.voiceEnabled) {
      try {
        const port = await this.casts.start()
        this.log('voice:listening', { port })
      } catch (e) {
        this.log('voice:listen-failed', { err: e?.message })
      }
    }

    // Arm the scheduled auto-rescan from the persisted setting (a no-op when off).
    this._armRescan()

    await this.host.ready()
    return this
  }

  // --- operator actions: the package does the work, this adds PearTune's rules ------

  // A source that cannot enforce a narrowing must not accept one - the People page never
  // offers it, and this refusal is the API's word for the same rule. An EXISTING narrowing
  // under a swapped source fails closed in visibility.viewOf.
  _refuseNarrowingIfUnsupported (paths) {
    if (paths != null && !(this.adapter && this.adapter.canNarrow)) {
      throw new Error('this music source cannot narrow by folder (folder libraries only)')
    }
  }

  // expiresMs > 0 opens a GUEST window; owner:true opens an OWNER window (proposal
  // 2026-07-24, P2); paths narrows who pairs through it. Fail at the OPEN, not at the scan.
  //
  // null paths means "this window says nothing about folders", which the package spells
  // undefined. The package reads null as "everything", which would WIDEN an already-paired,
  // narrowed device that scans a plain QR.
  startPairing ({ expiresMs = null, owner = false, paths = null } = {}) {
    if (!owner) this._refuseNarrowingIfUnsupported(paths)
    return this.host.startPairing({ expiresMs, owner, paths: paths == null ? undefined : paths })
  }

  stopPairing () {
    return this.host.stopPairing()
  }

  // Change which person a device belongs to, THROUGH the host: the live connections get the
  // new grant in place and the device is pushed 'grant:changed'. null for an unknown device,
  // which the dashboard turns into a 404.
  async assignDevice (deviceKey, personId) {
    const r = await this.host.assignDevice(deviceKey, personId)
    return r.grant ? r : null
  }

  // Narrow (or widen) a person to chosen folders, THROUGH the host (proposal
  // 2026-08-31-per-person-folders).
  async setPersonPaths (personId, paths) {
    this._refuseNarrowingIfUnsupported(paths)
    return this.host.setPersonPaths(personId, paths)
  }

  refreshGrant (row) { return this.host.refreshGrant(row) }
  notifyOwnersDevicesChanged () { return this.host.notifyOwnersDevicesChanged() }
  claimOwner (deviceKey, code) { return this.host.claimOwner(deviceKey, code) }
  revokeDevice (deviceKey) { return this.host.revokeDevice(deviceKey) }
  leaveDevice (deviceKey) { return this.host.leaveDevice(deviceKey) }
  setDeviceExpiry (deviceKey, expiresAt) { return this.host.setDeviceExpiry(deviceKey, expiresAt) }
  revokePerson (personId) { return this.host.revokePerson(personId) }
  deleteDevice (deviceKey) { return this.host.deleteDevice(deviceKey) }
  deletePerson (personId) { return this.host.deletePerson(personId) }
  listDevices () { return this.host.listDevices() }

  // The request queue for the OWNER app (P2b), enriched with WHO asked - same shape the
  // dashboard shows. Names are resolved from persons/devices so the owner sees a person,
  // not an opaque ownerId. Text is length-capped at the host writer + escaped by the app.
  async ownerRequestList () {
    const [personLabel, devices] = await Promise.all([this.grants.personLabels(), this.listDevices()])
    const reqName = (ownerId) => {
      if (ownerId?.startsWith('p:')) return personLabel.get(ownerId.slice(2)) || 'Someone'
      if (ownerId?.startsWith('d:')) return devices.find(d => d.deviceKey === ownerId.slice(2))?.label || 'A device'
      return 'Someone'
    }
    return (await this.userState.listRequests()).map(r => ({ ...r, requesterName: reqName(r.requester) }))
  }

  // Resolve a request AND tell whoever asked (P3). One place, because two doors reach it - the
  // owner phone (owner.requestResolve on media) and the dashboard (/api/requests/resolve) - and
  // both must push the same request:resolved to the requester's live devices. Best-effort: if
  // they are offline the push reaches no one and they see the status on their next request.list.
  // Keyed by the row's stored requester (the "p:"/"d:" ownerId), so it lands on any device that
  // person is signed in on. Returns the resolved row (null if there was no such request).
  async resolveRequestAndNotify (id, status) {
    const row = await this.userState.resolveRequest(id, status)
    if (row) {
      this.presence.notifyOwner(row.requester, 'request:resolved', {
        id: row.id, status: row.status, kind: row.kind, name: row.name, artist: row.artist
      })
      // ...and the OPERATORS, who are watching the same queue from the app. Only the requester
      // was ever told, so resolving on the DASHBOARD left every owner's Manage list showing the
      // row as still pending until something made the app ask again (Tim, 2026-07-30). Awaited
      // for the same reason the requester push is not: this one reads the grant store.
      await notifyOwners(this.presence, this.grants, 'requests:changed', { reason: 'resolved', id: row.id, status: row.status })
    }
    return row
  }

  // --- voice control (proposal 2026-08-02) ---------------------------------
  //
  // Voice plays as a REAL grant rather than a special case in the security path, so
  // revoking it is the same revoke as revoking a phone - the audio route's live grant
  // re-read denies it and casts.stopFor silences the speaker, with no new code in either.
  //
  // The device key is random bytes with NO private half anywhere, so nothing can ever open
  // a Noise connection as this device. It exists only to be looked up locally.
  async enableVoice ({ entityId = '' } = {}) {
    const cfg = this.speakers.config
    let voiceKey = cfg.voiceKey
    if (!voiceKey) {
      voiceKey = z32.encode(crypto.randomBytes(32))
      await this.grants.grant({
        deviceKey: voiceKey,
        label: 'Home Assistant voice',
        platform: 'voice',
        scope: SCOPE.OWNER, // what CAST_SCOPES requires; unusable over Noise regardless
        grantedBy: 'operator'
      })
      this.log('voice:granted', { device: voiceKey.slice(0, 8) })
    } else {
      // Re-enabling after a revoke: the row is tombstoned, so mint a fresh one rather
      // than trying to un-revoke, which grants.js deliberately refuses.
      const row = await this.grants.get(voiceKey)
      if (!row || row.revokedAt) {
        voiceKey = z32.encode(crypto.randomBytes(32))
        await this.grants.grant({
          deviceKey: voiceKey,
          label: 'Home Assistant voice',
          platform: 'voice',
          scope: SCOPE.OWNER,
          grantedBy: 'operator'
        })
        this.log('voice:regranted', { device: voiceKey.slice(0, 8) })
      }
    }
    const voiceToken = crypto.randomBytes(32).toString('base64url')
    this.speakers.save({ voiceEnabled: true, voiceKey, voiceToken, voiceEntityId: entityId })
    // The route has to be LISTENING before we hand out a URL for it. The cast server is
    // otherwise lazy (it starts on the first cast), which would have meant the address in
    // someone's configuration.yaml refused connections until they happened to cast first.
    const port = await this.casts.start()
    this.notifyOwnersDevicesChanged()
    return { ok: true, voiceToken, voiceKey, port }
  }

  // WRITE THE HOME ASSISTANT CONFIG FOR THEM, when they have opted in by giving us the path.
  //
  // Only ever two files, both named here rather than derived from anything the browser sends:
  // <dir>/packages/peartune.yaml, and the one-time packages include appended to
  // configuration.yaml if it is not already loading them. Nothing else in that directory is
  // read, written or listed. The path itself is checked by canWriteHaConfig, which refuses
  // anything without a configuration.yaml in it.
  //
  // The alternative was asking people to place a file by hand, and on Umbrel - which runs the
  // CONTAINER install of Home Assistant, with no Supervisor and so no File Editor add-on -
  // there is no way to do that from inside Home Assistant at all.
  async writeHaConfig ({ yaml, include }) {
    const dir = this.speakers.haConfigDir
    const check = canWriteHaConfig(dir)
    if (!check.ok) throw new Error(check.why || 'no Home Assistant config folder is set')
    if (!yaml || typeof yaml !== 'string') throw new Error('nothing to write')

    const pkgDir = path.join(dir, 'packages')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'peartune.yaml'), yaml)

    // The include is APPENDED only when packages are not already being loaded - never
    // rewritten, never reordered. Somebody else's configuration.yaml is not ours to tidy.
    const cfgPath = path.join(dir, 'configuration.yaml')
    let addedInclude = false
    const cfg = fs.readFileSync(cfgPath, 'utf8')
    if (!/^\s*packages:\s*!include_dir_named/m.test(cfg)) {
      fs.copyFileSync(cfgPath, cfgPath + '.peartune-backup')
      fs.appendFileSync(cfgPath, '\n' + (include || '') + '\n')
      addedInclude = true
    }
    this.log('speakers:ha-config-written', { dir, addedInclude })
    return { ok: true, addedInclude, path: path.join(pkgDir, 'peartune.yaml') }
  }

  // Off means OFF: the token goes, and the grant is revoked so anything mid-flight dies on
  // the same path a revoked phone does.
  async disableVoice () {
    const key = this.speakers.config.voiceKey
    if (key) {
      await this.grants.revoke(key, { by: 'operator' }).catch(() => null)
      await this.casts.stopFor(Grants.keyOf(key)).catch(() => 0)
    }
    this.speakers.save({ voiceEnabled: false, voiceToken: '' })
    this.log('voice:disabled')
    this.notifyOwnersDevicesChanged()
    return { ok: true }
  }

  // What the dashboard's device list adds to the package's row: what the device says it is
  // playing, and its photo.
  async _decorateDevice (r, online) {
    let nowPlaying = null
    if (online && !r.revokedAt) {
      // ONE library shows now-playing: the one the track came from, which is the one that
      // reported it. The play SESSION is deliberately NOT a source here (Tim, 2026-07-28):
      // it was, for a few hours, and every song appeared on two dashboards at once. "Where
      // the music is coming from" is the useful one - an operator wants to know whether
      // anyone is listening to THEIR library. A phone too old to send nowplaying.set shows
      // nowhere rather than on its session home.
      const said = this._nowPlaying.get(r.deviceKey)
      if (said && Date.now() - said.at < NOWPLAYING_STALE_MS) {
        nowPlaying = {
          title: said.title,
          artist: said.artist,
          playing: said.playing,
          reported: true,
          coverId: await this._coverIdFor(said.trackId)
        }
      }
    }
    return {
      ...r,
      nowPlaying,
      hasAvatar: this.avatars.has(r.deviceKey),
      avatarAt: this.avatars.at(r.deviceKey)
    }
  }

  // trackId -> coverId, cached: a track's cover is stable, so a network-backed source
  // (Subsonic/Jellyfin) is asked at most once per track rather than every 3s poll.
  // The device's own report of what it is playing from us (proposal 2026-07-28). Overwrites per
  // beat; a null/blank report clears it immediately, which is what a stop or a move to another
  // library's track sends. One Map write, no I/O.
  _noteNowPlaying (deviceKey, np) {
    if (!deviceKey) return
    const trackId = np && np.trackId
    if (!trackId) { this._nowPlaying.delete(deviceKey); return }
    this._nowPlaying.set(deviceKey, {
      trackId: String(trackId),
      title: np.title ? String(np.title).slice(0, 300) : null,
      artist: np.artist ? String(np.artist).slice(0, 300) : null,
      playing: !!np.playing,
      at: Date.now()
    })
  }

  // Record that we just served `trackId` to `deviceKey`. Kept because it costs one Map write and
  // says something true (we served these bytes), but it is NOT what the dashboard shows - see the
  // NOWPLAYING_STALE_MS note for why serving is not playing.
  _noteStreaming (deviceKey, trackId) {
    if (!deviceKey || !trackId) return
    this._streaming.set(deviceKey, { trackId, at: Date.now() })
  }

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
    if (this._rescanTimer) clearInterval(this._rescanTimer)
    // Before the host closes: stopFor() silences speakers, and a speaker left playing from a
    // URL that has stopped answering is a worse ending than silence.
    await this.casts.close().catch(() => {})
    await this.host.close()
  }
}

module.exports = { PearTuneHost, PROTOCOL }
