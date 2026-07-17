// PearTune Bare worklet: the P2P backend that runs inside the app.
//
// Owns three things:
//   1. the device identity (a keypair, persisted; it IS this device's grant)
//   2. the PearTuneClient (pairing + the media API over HyperDHT)
//   3. the audio shim, a localhost HTTP server the Android player streams from
//
// The shell talks to it over BareKit IPC with { id, method, args }, exactly like
// PearCal / PearGuard / PearCircle / PearList.
//
// NOTE FOR ANYONE EDITING: this is Bare, not Node. There is no `process`, and
// `require('fs')` is `bare-fs`. A Node-ism here compiles fine and then explodes
// on the phone, where you have no debugger.

/* global BareKit */

const fs = require('bare-fs')
const path = require('bare-path')
const b4a = require('b4a')
const z32 = require('z32')
const hcrypto = require('hypercore-crypto')

const { PearTuneClient } = require('../client')
const { createAudioShim, mimeFor, DEFAULT_ART_SIZE } = require('../worklet/shim')
const { streamParams } = require('../worklet/quality')
const { isPairLink } = require('../protocol/link')
const { coalesce, clientCall } = require('../worklet/outbox')
const { AudioCache } = require('../worklet/cache')
const { ArtStore } = require('../worklet/art-cache')

const DATA_DIR = Bare.argv[0] || '/tmp/peartune'
const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json')
const HOSTS_FILE = path.join(DATA_DIR, 'hosts.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
// The persisted PLAY QUEUE, so a force-stop or a relaunch does not lose it. Holds
// track IDs + render metadata (the shell's toQueue shape) + index + position +
// shuffle/repeat - NEVER the loopback URLs, which carry the shim's port and change
// every launch. On boot the shell rebuilds the paused queue and re-resolves URLs.
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json')
// A read-through cache of THIS device's favorite trackIds. The host is the source of
// truth (host-as-hub); this only lets the hearts render instantly and offline. Writes
// still go to the host (favorites need a connection in Phase 1).
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json')
// A read-through cache of THIS device's playlist SUMMARIES ([{ id, name, count }]), so
// the Playlists list renders instantly and offline. The host owns the truth; a
// playlist's tracks and every edit still need a connection (Phase 4, like favorites).
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json')
// The offline write-queue: state writes (favorite / resume / count) made while the host
// was unreachable, replayed in order on the next connect (milestone 3, phase 5).
const OUTBOX_FILE = path.join(DATA_DIR, 'outbox.json')
// The on-disk AUDIO cache: tracks played to the end, kept for offline playback and
// evicted oldest-first under a size cap (milestone 3, phase 5B).
const AUDIO_DIR = path.join(DATA_DIR, 'audio')
const ART_DIR = path.join(DATA_DIR, 'art')
const DEFAULT_CACHE_CAP = 1024 * 1024 * 1024 // 1 GB
// The offline LEASE (milestone 3, phase 5B). A stopped host and a revoke look identical
// at the connection layer (both just close), so we cannot safely purge on a refused
// reconnect - a server that is merely OFF would lose your downloads (confirmed on
// hardware). Instead: every successful connect stamps "last authorized"; cached audio
// only plays while that stamp is within the grace window. A revoked device never
// re-authorizes, so its downloads go dark after the grace; a device whose server is off
// re-authorizes the moment it is back. Files are NOT deleted on expiry - re-pairing (a
// fresh authorization) makes them playable again.
const LEASE_FILE = path.join(DATA_DIR, 'lease.json')
const LEASE_GRACE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days
// The PINNED-ALBUM registry (milestone 3, phase 5C): what the user explicitly downloaded,
// separate from the auto-LRU cache. Maps albumId -> { id, name, artist, coverId, trackIds,
// addedAt, complete }. The bytes live in the audio cache (marked pinned); this is the
// human-facing list the Downloads view shows and unpins.
const PINS_FILE = path.join(DATA_DIR, 'pins.json')

const DEFAULT_SETTINGS = {
  theme: 'system', deviceName: '', userName: '', streamQuality: 'auto',
  cacheCap: DEFAULT_CACHE_CAP, downloadCellular: false
}

// What the network is right now, as reported by the shell (expo-network). Default
// 'wifi' - the safe assumption, because wifi means original quality, i.e. no surprise
// transcode and no surprise data use until we actually know we are on cellular.
let networkType = 'wifi'

let client = null
let shim = null
let shimPort = null
let identity = null
let currentHost = null
let connected = false
let reconnecting = null // the in-flight reconnect, so N callers share ONE attempt

// --- cross-device session handoff (proposal 2026-07-17) ---------------------
// This device holds the host's session "active player" token while it is the one playing.
// While active, saveQueueState mirrors the queue to the host so another device can "Play
// here"; a rejected push (ok:false) means we were superseded and must pause (lazy presence).
let sessionActive = false // do we currently hold the token?
let sessionGen = 0 // the generation we last saw (for the claim CAS)
let sessionSupported = true // false once a host answers ENOMETHOD - degrade silently

// --- IPC --------------------------------------------------------------------

function send (msg) {
  BareKit.IPC.write(b4a.from(JSON.stringify(msg) + '\n'))
}

function emit (name, data) {
  send({ event: name, data })
}

function log (msg, data) {
  console.warn('[worklet]', msg, data ? JSON.stringify(data) : '')
  emit('log', { msg, data })
}

// --- identity ---------------------------------------------------------------

// The device keypair is not a convenience, it is the account. The host's grant is
// keyed to this public key, so losing this file means the phone is a stranger
// again and must re-pair. Keep it out of anything that syncs.
function loadIdentity () {
  try {
    const raw = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'))
    return {
      publicKey: b4a.from(raw.publicKey, 'hex'),
      secretKey: b4a.from(raw.secretKey, 'hex')
    }
  } catch {
    const kp = hcrypto.keyPair()
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify({
      publicKey: b4a.toString(kp.publicKey, 'hex'),
      secretKey: b4a.toString(kp.secretKey, 'hex')
    }))
    return kp
  }
}

function loadHost () {
  try {
    return JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'))
  } catch {
    return null
  }
}

function saveHost (h) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(HOSTS_FILE, JSON.stringify(h))
}

// --- settings ---------------------------------------------------------------
//
// Settings live in the worklet, next to the identity and the host, rather than in
// the WebView's localStorage: the WebView's storage is the one thing in this app
// that a routine `pm clear`-style wipe or a WebView data reset can take out from
// under us, and losing the theme is not the point - keeping ONE place where "what
// this device knows" lives is.
function loadSettings () {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings (patch) {
  const next = { ...loadSettings(), ...patch }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next))
  return next
}

// The favorites cache mirrors the host's grouped shape { track, album, artist } (each
// an array of ids). It is disposable - the host owns the truth - so a missing or
// corrupt file is simply "no favorites cached yet".
function loadFavCache () {
  try {
    const o = JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'))
    return { track: o.track || [], album: o.album || [], artist: o.artist || [] }
  } catch {
    return { track: [], album: [], artist: [] }
  }
}

function saveFavCache (g) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify({
    track: g.track || [], album: g.album || [], artist: g.artist || []
  }))
}

// Same disposable-mirror deal for playlist summaries.
function loadPlaylistCache () {
  try {
    const o = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8'))
    return Array.isArray(o) ? o : []
  } catch {
    return []
  }
}

function savePlaylistCache (items) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(items || []))
}

// --- offline write-queue (milestone 3, phase 5) -----------------------------
//
// A state write that fails because the host is unreachable is queued to disk and
// replayed, in order, the next time we connect. The coalescing (a favorite/resume keeps
// only its latest, a play count accumulates) lives in worklet/outbox.js so it is testable;
// here we just persist it and drive the client.
let outbox = loadOutbox()
let flushing = false

// The audio cache singleton. Its cap comes from settings (a Storage choice); the shim
// writes tracks through it and serves them back, and a revoke purges it.
const audioCache = new AudioCache({
  dir: AUDIO_DIR,
  cap: Number(loadSettings().cacheCap) || 0,
  log
})

// Persistent covers for downloaded albums, so Downloads shows real art offline. Small,
// bounded by the pinned albums; the shim reads it as an offline fallback (lease-gated).
const artStore = new ArtStore({ dir: ART_DIR })

function loadOutbox () {
  try {
    const o = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8'))
    return Array.isArray(o) ? o : []
  } catch {
    return []
  }
}

function saveOutbox () {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(OUTBOX_FILE, JSON.stringify(outbox))
}

function enqueue (method, params) {
  outbox = coalesce(outbox, { method, params })
  saveOutbox()
  log('outbox:queued', { method, depth: outbox.length })
}

// Replay the queue head-first. Stop at the first failure (still offline / a transient
// error) and leave the rest for next time - order is preserved and each write is
// idempotent on the host (LWW for fav/resume, a monotonic bump for counts), so a partial
// flush is safe.
async function flushOutbox () {
  if (flushing || !outbox.length || !client) return
  flushing = true
  try {
    while (outbox.length) {
      const entry = outbox[0]
      const call = clientCall(client, entry)
      if (!call) { outbox = outbox.slice(1); saveOutbox(); continue } // unknown method: drop it
      try {
        await call()
      } catch {
        break // still cannot reach the host; keep this and everything after it
      }
      outbox = outbox.slice(1)
      saveOutbox()
    }
    if (!outbox.length) log('outbox:drained')
  } finally {
    flushing = false
  }
}

// --- the offline lease (phase 5B) -------------------------------------------
function loadLastAuth () {
  try { return Number(JSON.parse(fs.readFileSync(LEASE_FILE, 'utf8')).lastAuth) || 0 } catch { return 0 }
}
function stampAuth () {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(LEASE_FILE, JSON.stringify({ lastAuth: Date.now() }))
  } catch {}
}
// Cached audio plays only while the last successful authorization is inside the grace
// window. This is what makes a revoked device eventually lose its downloads without ever
// deleting a legitimate user's on a server hiccup.
function leaseValid () {
  const la = loadLastAuth()
  return la > 0 && (Date.now() - la) < LEASE_GRACE_MS
}

// --- pinned-album registry (phase 5C) ---------------------------------------
function loadPins () {
  try {
    const o = JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'))
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}
function savePins (pins) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(PINS_FILE, JSON.stringify(pins))
}

// Wipe every local copy: downloaded audio, cached favorites/playlists, unsent writes, the
// lease, and the pin registry. Used on UNPAIR (a deliberate, reliable purge point) - NOT on
// a reconnect failure, which cannot tell a revoke from a server that is simply off.
function purgeAll () {
  try { audioCache.clear() } catch {}
  try { artStore.clear() } catch {}
  for (const f of [FAVORITES_FILE, PLAYLISTS_FILE, OUTBOX_FILE, LEASE_FILE, PINS_FILE]) { try { fs.unlinkSync(f) } catch {} }
  outbox = []
  log('local:purged')
}

// --- connection -------------------------------------------------------------

async function ensureClient () {
  if (client) return client
  client = new PearTuneClient({ keyPair: identity, log })
  return client
}

// The shim is created ONCE, on boot, independent of any connection - so a cached track
// plays from disk even when we cannot reach the host (offline, or a cold launch on a
// plane). It KEEPS ITS PORT for the life of the process: the player holds
// http://127.0.0.1:<port>/t/<id> URLs, and a fresh port would strand a paused queue.
// Its client is REPLACEABLE (null until the first connect); the cache-hit path never
// touches it, and the live path calls ensure() first, which connects and sets it.
async function ensureShim () {
  if (shim) return shimPort
  shim = createAudioShim({
    client: null,
    log,
    ensure: ensureConnected,
    // Read fresh each request so a Settings change (or a wifi->cellular flip) applies
    // to the next track without rebuilding the shim.
    quality: () => streamParams(loadSettings(), networkType),
    cache: audioCache,
    artStore,
    // The lease gate: a cached track is only served from disk while authorization is
    // fresh. Expired (a revoked or long-offline device) falls through to the live path.
    leaseOk: leaseValid
  })
  shimPort = await shim.listen()
  return shimPort
}

async function connectTo (host) {
  await ensureClient()
  await client.connect({ hostKey: host.hostKey, libraryId: host.libraryId })
  currentHost = host
  connected = true
  // A successful connect IS a fresh authorization - renew the offline lease.
  stampAuth()

  // Point the (already-listening) shim at the fresh client. Playback still flows
  // THROUGH the live connection for anything not cached, which is what makes a revoke
  // stop the music.
  await ensureShim()
  shim.setClient(client)

  // The connection is gone: revoked, or the host went away, or - by far the most
  // common - Android suspended this app in the background and the link timed out.
  // Those are indistinguishable from here, so do NOT guess at the reason. Say what
  // happened and let whoever asks next reconnect.
  client.conn.once('close', () => {
    connected = false
    log('host:disconnected')
    emit('host:disconnected', { hostKey: host.hostKey })
  })

  emit('host:connected', {
    libraryName: host.libraryName,
    libraryId: host.libraryId,
    shimPort,
    artBase: shim.artBase()
  })

  // Drain anything queued while we were offline (favorites/resume/counts). Fire and
  // forget - a slow flush must not hold up the connection or the UI.
  flushOutbox().catch(() => {})

  return { ...host, shimPort }
}


// Reconnect ON DEMAND, and only once.
//
// Android suspends a backgrounded app that is not holding a foreground service, so
// an idle PearTune loses its link within about twenty seconds - the host logs the
// channel closing. This is normal and unavoidable, and it is NOT worth burning
// battery on a permanent foreground service to prevent (when music is playing or
// paused with a queue, the media session already keeps the process alive and the
// link survives - measured).
//
// So: the link is allowed to die, and ANY caller that needs it silently brings it
// back. The single-flight promise matters more than it looks - a screen coming
// back to life fires `albums`, `artists` and a fistful of `art` requests in the
// same tick, and without it each one would dial the host separately.
async function ensureConnected () {
  if (connected && client) return

  const host = loadHost()
  if (!host) throw new Error('Not paired with a library.')

  if (!reconnecting) {
    reconnecting = (async () => {
      // The old client is dead once its connection closed, and a half-dead client
      // is worse than none: it fails on the first stream instead of here, where we
      // can still do something about it. The SHIM survives (see connectTo).
      if (client) {
        try {
          await client.close()
        } catch {}
        client = null
      }
      await connectTo(host)
    })().finally(() => { reconnecting = null })
  }

  await reconnecting
}

// --- methods ----------------------------------------------------------------

// Artwork arrives over P2P through the shim's loopback server, so anything the UI
// will <img src> has to be resolved to a loopback URL here, where the shim is.
const withArt = (x) => ({
  ...x,
  art: x.coverId && shim ? shim.artUrlFor(x.coverId) : null
})

// The same cover, big, for the full-screen viewer. Only handed out on the detail
// screens: putting a 1200px URL on all 60 tiles of a grid would invite the WebView
// to fetch 60 of them over P2P for a picture nobody has asked to see yet.
const withBigArt = (x) => ({
  ...withArt(x),
  artFull: x.coverId && shim ? shim.artUrlFor(x.coverId, 1200) : null
})

const methods = {
  async init () {
    identity = loadIdentity()
    const host = loadHost()
    const state = {
      deviceKey: b4a.toString(identity.publicKey, 'hex'),
      // The SAME encoding the host's dashboard prints in its device rows (grants
      // are keyed by z32). Settings shows this so an operator deciding which row
      // to revoke can match the phone in their hand to a line on the screen.
      deviceKeyZ32: z32.encode(identity.publicKey),
      host: host || null,
      settings: loadSettings(),
      connected: false
    }
    if (host) {
      // Bring the shim up FIRST, so its port and art base exist (and cached tracks can
      // play) even when the connect below fails - a cold launch offline still plays
      // your downloads.
      await ensureShim()
      state.shimPort = shimPort
      state.artBase = shim.artBase()
      // Connect in the BACKGROUND. The connect can take up to the timeout when the host
      // is unreachable, and blocking init on it would leave a cold launch stuck on
      // "Starting…" for 20s - unbearable, and pointless when the useful surfaces
      // (Downloads, Settings) are all local. host:connected updates the UI when it lands;
      // a failure just leaves us in the normal "not connected" state.
      connectTo(host).catch((e) => {
        log('init:connect-failed', { err: e.message })
        emit('host:disconnected', { hostKey: host.hostKey })
      })
    }
    return state
  },

  async pair ({ link, label, userName }) {
    if (!isPairLink(link)) throw new Error('That is not a PearTune pairing code.')
    await ensureClient()

    // The name goes out in deviceHello's EXISTING label field, so this half needs
    // no wire change at all - we were simply hardcoding "Android phone" and giving
    // the operator two identical rows to choose between.
    const name = (label || '').trim() || 'Android phone'

    const paired = await client.pair(link, {
      label: name,
      platform: 'android'
    })

    saveSettings({ deviceName: name, userName: (userName || '').trim() })

    const host = {
      hostKey: paired.hostKey && paired.hostKey.length === 32
        ? require('z32').encode(paired.hostKey)
        : paired.hostKey,
      libraryId: paired.libraryId,
      libraryName: paired.libraryName
    }
    saveHost(host)

    await connectTo(host)
    return { ...host, shimPort }
  },

  async reconnect () {
    await ensureConnected()
    return { ok: true, connected, shimPort }
  },

  async stats () {
    await ensureConnected()
    return client.stats()
  },

  // The Songs view. Navidrome answers an empty-query search3 with everything,
  // paged, so this is a real list and not the 60-call album walk it used to be.
  async tracks ({ cursor = 0, limit = 100, sort, order } = {}) {
    await ensureConnected()
    const page = await client.list({ type: 'tracks', cursor, limit, sort, order })
    return { ...page, items: page.items.map(withArt) }
  },

  // Album browsing is the primary way in. A flat list of 1358 tracks is not a
  // music app, and Subsonic has no "all songs" call anyway - so the flat list
  // could only ever show the first page. Albums page properly.
  async albums ({ cursor = 0, limit = 60, sort, order } = {}) {
    await ensureConnected()
    const page = await client.list({ type: 'albums', cursor, limit, sort, order })
    return { ...page, items: page.items.map(withArt) }
  },

  async album ({ id }) {
    await ensureConnected()
    const a = await client.get({ id, type: 'album' })
    return a ? withBigArt(a) : null
  },

  // Artists are the second way in. The host has always been able to list them
  // (`library.list({type:'artists'})`); nothing was asking.
  async artists ({ sort, order } = {}) {
    await ensureConnected()
    const page = await client.list({ type: 'artists', sort, order })
    return { ...page, items: page.items.map(withArt) }
  },

  // An artist page is a grid of that artist's albums, so its albums need art too.
  async artist ({ id }) {
    await ensureConnected()
    const a = await client.get({ id, type: 'artist' })
    if (!a) return null
    // `tracks` is only ever populated for an artist with NO albums - Navidrome's
    // composite-tag artists ("Artist/Remixer"). See the host adapter.
    return {
      ...withBigArt(a),
      albums: (a.albums || []).map(withArt),
      tracks: (a.tracks || []).map(withArt)
    }
  },

  // Every track an artist has, in album order - what "Play" on an artist means.
  //
  // It costs one round trip per album, because an album's track list only exists
  // inside getAlbum. That is fine for the handful of albums an artist actually has,
  // and it is the same call the album screen makes anyway. Tracks inherit their
  // album's artwork, so the queue and the lock screen have a picture.
  async artistTracks ({ id }) {
    await ensureConnected()
    const a = await client.get({ id, type: 'artist' })
    if (!a) return { items: [] }

    // An artist with no albums still has songs (see the host adapter). Play those
    // rather than reporting an empty artist, which is what "nothing to play there"
    // used to mean.
    if (!(a.albums || []).length) return { items: (a.tracks || []).map(withArt) }

    const items = []
    for (const al of a.albums || []) {
      const full = await client.get({ id: al.id, type: 'album' })
      if (!full) continue
      const art = full.coverId && shim ? shim.artUrlFor(full.coverId) : null
      const artFull = full.coverId && shim ? shim.artUrlFor(full.coverId, 1200) : null
      for (const t of full.tracks || []) items.push({ ...t, art, artFull })
    }
    return { items }
  },

  async search ({ q }) {
    await ensureConnected()
    const r = await client.search({ q })
    return {
      ...r,
      albums: (r.albums || []).map(withArt),
      artists: (r.artists || []).map(withArt)
    }
  },

  async settings () {
    return loadSettings()
  },

  // --- identity ---------------------------------------------------------------
  //
  // Kept in the worklet's settings (so Settings can show it before the host answers)
  // AND pushed to the host, which is the authority on what its dashboard shows.
  async identity () {
    const local = loadSettings()
    let remote = null
    try {
      await ensureConnected()
      remote = await client.getIdentity()
    } catch {
      // Offline, or an old host. The local names are still the truth about what we
      // last asked for.
    }
    return {
      deviceName: remote?.deviceName || local.deviceName || '',
      userName: remote?.user?.name || local.userName || '',
      confirmed: !!remote?.user?.confirmed,
      belongsTo: remote?.belongsTo || null,
      // A guest pass's expiry (null = permanent / offline / old host), so the UI can show
      // a countdown banner. Only meaningful when we actually reached the host this call.
      expiresAt: remote?.expiresAt ?? null,
      supported: remote !== null
    }
  },

  async setIdentity ({ deviceName, userName }) {
    await ensureConnected()
    const r = await client.setIdentity({ deviceName, userName })
    saveSettings({
      deviceName: r?.deviceName || deviceName || '',
      userName: r?.user?.name || userName || ''
    })
    return {
      deviceName: r?.deviceName || '',
      userName: r?.user?.name || '',
      confirmed: !!r?.user?.confirmed,
      belongsTo: r?.belongsTo || null
    }
  },

  async setSettings (patch) {
    return saveSettings(patch || {})
  },

  // --- persisted play queue (restore on launch) -------------------------------
  //
  // The queue's source of truth lives in the RN shell (ExoPlayer's playlist). The
  // shell snapshots it here on every change so a force-stop or relaunch can rebuild
  // it, PAUSED, seeked to where you were. IDs + metadata only, never URLs.
  async saveQueueState (snapshot) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(snapshot || {}))
    } catch {}

    // If we hold the session token, mirror the queue to the host so another device can
    // "Play here". Items go as { trackId, ...meta } (id -> trackId is the host contract); no
    // stream URLs (the receiver re-resolves via urlFor, exactly as launch-restore does; the art
    // shim URL is port-rewritten on the receiver). A rejected push means we were superseded -
    // report lostSession so the shell pauses (lazy presence).
    //
    // This pushes on EVERY snapshot (the shell already throttles saveQueueState to ~4s), NOT
    // only on a structural change - because the push IS the lazy-presence heartbeat: a steadily
    // playing device with an unchanging queue must still periodically hear "you lost the token".
    // Dedup-by-content would silence that and let two devices play at once. (Large-queue write
    // cost is the proposal's deferred open question #2.)
    let lostSession = false
    if (sessionActive && sessionSupported && connected && client && snapshot) {
      const items = Array.isArray(snapshot.items) ? snapshot.items : []
      try {
        const queue = items.map(t => ({ trackId: t.id, title: t.title, artist: t.artist, album: t.album, art: t.art, artFull: t.artFull, durationMs: t.durationMs }))
        const r = await client.sessionSet({ queue, index: snapshot.index || 0, shuffle: !!snapshot.shuffle, repeat: Number(snapshot.repeat) || 0 })
        if (r && r.ok === false) { sessionActive = false; lostSession = true } // superseded
      } catch (e) {
        if (e?.code === 'ENOMETHOD') sessionSupported = false
        // offline / transient: keep the token, retry on the next snapshot
      }
    }
    return { ok: true, lostSession }
  },
  async loadQueueState () {
    try {
      return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
    } catch {
      return null
    }
  },
  async clearQueueState () {
    try { fs.unlinkSync(QUEUE_FILE) } catch {}
    return { ok: true }
  },

  // --- cross-device session handoff (proposal 2026-07-17) ---------------------
  //
  // Become the active player. Called by the shell when playback starts here. Idempotent: a no-op
  // if we already hold the token. Otherwise read the current generation and CAS-claim it (one
  // retry if another device claimed in the same instant). Claiming ADOPTS the existing queue on
  // the host; the shell's next saveQueueState overwrites it with ours.
  async sessionActivate () {
    if (!sessionSupported) return { active: false, supported: false }
    if (sessionActive) return { active: true }
    try {
      await ensureConnected()
      for (let i = 0; i < 2; i++) {
        const cur = await client.sessionGet()
        const r = await client.sessionClaim({ generation: cur?.generation || 0 })
        if (r?.ok) { sessionActive = true; sessionGen = r.session.generation; return { active: true } }
      }
      return { active: false }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') { sessionSupported = false; return { active: false, supported: false } }
      return { active: false } // offline; the next play retries
    }
  },

  // Stop being the active player (the shell's stop). Does NOT release the host token - the
  // session persists as last-known so another device can still "Play here"; we just stop pushing.
  sessionDeactivate () { sessionActive = false; return { ok: true } },

  // What the UI needs for the "Playing on <name>" card: is another of my devices actively
  // holding a non-empty session. Tracks the generation for a later claim.
  async sessionInfo () {
    if (!sessionSupported) return { supported: false }
    try {
      await ensureConnected()
      const s = await client.sessionGet()
      if (s) sessionGen = s.generation
      return {
        supported: true,
        active: !!(s && s.isActiveHere), // is THIS device the active one
        hasQueue: !!(s && Array.isArray(s.queue) && s.queue.length > 0),
        activeDeviceName: s?.activeDeviceName || null,
        count: s?.queue?.length || 0
      }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') { sessionSupported = false; return { supported: false } }
      return { supported: true, offline: true }
    }
  },

  // "Play here": claim the token and hand the session queue back to the shell (mapped to its
  // shape) plus the current track's resume position, so the shell rebuilds + seeks + plays.
  async sessionTakeover () {
    if (!sessionSupported) return { ok: false, supported: false }
    try {
      await ensureConnected()
      for (let i = 0; i < 2; i++) {
        const s = await client.sessionGet()
        if (!s || !Array.isArray(s.queue) || !s.queue.length) return { ok: false, empty: true }
        const r = await client.sessionClaim({ generation: s.generation })
        if (r?.ok) {
          sessionActive = true; sessionGen = r.session.generation
          const items = r.session.queue.map(t => ({ id: t.trackId, title: t.title, artist: t.artist, album: t.album, art: t.art, artFull: t.artFull, durationMs: t.durationMs }))
          const cur = items[r.session.index || 0]
          let positionMs = 0
          if (cur) { try { const rp = await client.resumeGet({ trackId: cur.id }); positionMs = rp?.positionMs || 0 } catch {} }
          return { ok: true, items, index: r.session.index || 0, shuffle: !!r.session.shuffle, repeat: r.session.repeat || 0, positionMs }
        }
      }
      return { ok: false }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') { sessionSupported = false; return { ok: false, supported: false } }
      return { ok: false }
    }
  },

  // --- favorites (host-as-hub, milestone 3) -----------------------------------
  //
  // The host owns the truth; we keep a read-through cache so the hearts render
  // instantly and survive going offline. `supported` tells the UI whether the host is
  // new enough to answer at all - an old host replies ENOMETHOD, and the app hides
  // the hearts rather than showing a control that does nothing.
  // The favorite ID SETS, grouped { track, album, artist }, for overlaying hearts
  // everywhere. `supported:false` means an old host with no favorites support (the app
  // hides the hearts); on any other failure we fall back to the cache so hearts still
  // render offline.
  async favorites () {
    try {
      await ensureConnected()
      const g = await client.favList()
      const grouped = { track: g.track || [], album: g.album || [], artist: g.artist || [] }
      saveFavCache(grouped)
      return { ...grouped, supported: true }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') return { ...loadFavCache(), supported: false }
      return { ...loadFavCache(), supported: true, offline: true }
    }
  },

  // --- resume positions (milestone 3, phase 2) --------------------------------
  //
  // Fire-and-forget saves (the shell calls this on a timer while playing); a failure
  // is fine, the position is not precious. resumeGet answers 0 offline / on an old
  // host, so the caller simply starts the track from the top.
  async resumeSave ({ trackId, positionMs, durationMs }) {
    // When connected, write straight through; when not, queue immediately rather than
    // block this frequent call on a doomed connect. The flush rides the next reconnect.
    if (connected && client) {
      try { await client.resumeSet({ trackId, positionMs, durationMs }) } catch { enqueue('resume.set', { trackId, positionMs, durationMs }) }
    } else {
      enqueue('resume.set', { trackId, positionMs, durationMs })
    }
    return { ok: true }
  },

  async resumeGet ({ trackId }) {
    try {
      await ensureConnected()
      return await client.resumeGet({ trackId })
    } catch {
      return { positionMs: 0 }
    }
  },

  // The "continue listening" candidate: the most recent resume, RESOLVED to a
  // renderable track (title, artist, art) so the launch card can show it. Null when
  // there is nothing to continue, offline, or on an old host.
  async resumeLatest () {
    try {
      await ensureConnected()
      const r = await client.resumeLatest()
      if (!r?.trackId) return null
      const t = await client.get({ id: r.trackId, type: 'track' }).catch(() => null)
      if (!t) return null
      return { track: withArt(t), positionMs: r.positionMs, durationMs: r.durationMs }
    } catch {
      return null
    }
  },

  // --- play counts (milestone 3, phase 3) -------------------------------------
  //
  // Count a play (fire-and-forget); the app calls this once a track has been listened
  // to past a threshold. topPlayed resolves the most-played ids to renderable tracks
  // for the "Most played" view.
  async countBump ({ trackId }) {
    if (connected && client) {
      try { await client.countBump({ trackId }) } catch { enqueue('count.bump', { trackId }) }
    } else {
      // Offline: queue it (counts accumulate - each queued bump is a real play).
      enqueue('count.bump', { trackId })
    }
    return { ok: true }
  },

  async topPlayed ({ limit = 50 } = {}) {
    try {
      await ensureConnected()
      const { items } = await client.countTop({ limit })
      const out = []
      for (const it of items) {
        const t = await client.get({ id: it.trackId, type: 'track' }).catch(() => null)
        if (t) out.push({ ...withArt(t), playCount: it.count })
      }
      return { items: out }
    } catch {
      return { items: [] }
    }
  },

  // Toggle a favorite of any kind (track / album / artist). The local cache is updated
  // OPTIMISTICALLY (so the heart survives offline and a reload), then the write goes to
  // the host - or, if we are offline, into the write-queue for the next connect. An old
  // host that has no favorites (ENOMETHOD) is the one case we undo and report, so the UI
  // can say "favorites need a host update" instead of silently keeping a heart the host
  // will never know about.
  async toggleFav ({ kind = 'track', id, on }) {
    const want = on !== false
    const apply = (v) => {
      const cache = loadFavCache()
      const set = new Set(cache[kind] || [])
      if (v) set.add(id); else set.delete(id)
      cache[kind] = [...set]
      saveFavCache(cache)
    }
    apply(want)
    if (connected && client) {
      try {
        const r = await client.favSet({ kind, id, on: want })
        return { kind: r.kind, id: r.id, on: r.on }
      } catch (e) {
        if (e?.code === 'ENOMETHOD') { apply(!want); throw e }
        enqueue('fav.set', { kind, id, on: want })
        return { kind, id, on: want, queued: true }
      }
    }
    // Offline: queue now (instant), and nudge a reconnect in the background - a favorite
    // is user-initiated, so it is worth trying to sync it promptly. The flush happens
    // when the reconnect lands.
    enqueue('fav.set', { kind, id, on: want })
    ensureConnected().catch(() => {})
    return { kind, id, on: want, queued: true }
  },

  // The Favorites VIEW: the favorited ids of each kind resolved to renderable objects
  // (tracks, albums, artists), reusing the same library.get the rest of the app uses.
  // One get() per favorite - bounded by how many a person favorites. Anything that no
  // longer resolves (source changed, item gone) is skipped, not shown as a dead row.
  async favoriteItems () {
    await ensureConnected()
    const g = await client.favList()
    const grouped = { track: g.track || [], album: g.album || [], artist: g.artist || [] }
    saveFavCache(grouped)
    const resolve = async (ids, type) => {
      const out = []
      for (const id of ids) {
        const it = await client.get({ id, type }).catch(() => null)
        if (it) out.push(withArt(it))
      }
      return out
    }
    return {
      tracks: await resolve(grouped.track, 'track'),
      albums: await resolve(grouped.album, 'album'),
      artists: await resolve(grouped.artist, 'artist')
    }
  },

  // --- playlists (milestone 3, phase 4) ---------------------------------------
  //
  // OUR playlists, host-owned. The list caches its summaries so the Playlists tab
  // renders offline (like favorites); an old host answers ENOMETHOD and we report
  // supported:false so the app can hide the feature rather than show a dead control.
  async playlists () {
    try {
      await ensureConnected()
      const { items } = await client.playlistList()
      savePlaylistCache(items)
      return { items, supported: true }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') return { items: [], supported: false }
      return { items: loadPlaylistCache(), supported: true, offline: true }
    }
  },

  // One playlist. We return BOTH the raw ordered trackIds and the resolved tracks:
  // a track that no longer resolves (source changed, file gone) is left out of the
  // rendered list, but its id STAYS in trackIds and each resolved track carries its raw
  // index `_i`. That is what lets the app reorder/remove by editing the raw id list -
  // so an edit never silently drops a track that merely failed to resolve this time.
  async playlistDetail ({ id }) {
    await ensureConnected()
    const pl = await client.playlistGet({ id })
    const ids = pl.trackIds || []
    const tracks = []
    for (let i = 0; i < ids.length; i++) {
      const t = await client.get({ id: ids[i], type: 'track' }).catch(() => null)
      // `_i` is the raw slot (reassigned when the app reorders); `_k` is a STABLE
      // per-row identity for React keys, so a drag animates a move rather than
      // remounting rows (a track id can repeat within a playlist, so it cannot key).
      if (t) tracks.push({ ...withArt(t), _i: i, _k: tracks.length })
    }
    return { id: pl.id, name: pl.name, trackIds: ids, tracks }
  },

  async createPlaylist ({ name }) {
    await ensureConnected()
    return await client.playlistCreate({ name })
  },

  async renamePlaylist ({ id, name }) {
    await ensureConnected()
    return await client.playlistRename({ id, name })
  },

  async deletePlaylist ({ id }) {
    await ensureConnected()
    await client.playlistDelete({ id })
    return { ok: true }
  },

  // Append tracks. The UI resolves an album/artist to its trackIds first (via the same
  // tracksFor it uses for Play/Queue), so this just forwards the ids.
  async addToPlaylist ({ id, trackIds }) {
    await ensureConnected()
    return await client.playlistAdd({ id, trackIds })
  },

  // Replace the whole order - the app's single write path for both remove and reorder.
  async setPlaylistTracks ({ id, trackIds }) {
    await ensureConnected()
    return await client.playlistSetTracks({ id, trackIds })
  },

  // The SERVER's own playlists (v2), read-only. These come from Navidrome/Jellyfin via
  // the normal library.list/get - no host state involved - and the app shows them beside
  // our host-stored ones and can play them, but not edit them (DECISIONS: no write-back).
  // A folder source (or an old/limited server) simply returns none.
  async serverPlaylists () {
    try {
      await ensureConnected()
      const { items } = await client.list({ type: 'playlists' })
      return { items: items || [] }
    } catch {
      return { items: [] }
    }
  },

  async serverPlaylistDetail ({ id }) {
    await ensureConnected()
    const pl = await client.get({ id, type: 'playlist' })
    if (!pl) return null
    return { id: pl.id, name: pl.name, tracks: (pl.tracks || []).map(withArt) }
  },

  // The shell tells us what network we are on (expo-network). It drives 'auto'
  // quality: original on wifi, a capped mp3 on cellular. It does NOT tear down a
  // stream in flight - the change lands on the NEXT track, which is the right grain
  // (nobody wants their current song to re-buffer because they walked out of wifi).
  async setNetwork ({ type } = {}) {
    const t = type === 'cellular' || type === 'wifi' || type === 'none' ? type : 'wifi'
    if (t !== networkType) {
      networkType = t
      log('net:changed', { type: t })
    }
    return { networkType }
  },

  // The URL the RN player hands to ExoPlayer. The audio never touches RN: the
  // player pulls it from the worklet's loopback server, which pulls it over P2P.
  async urlFor ({ trackId }) {
    await ensureShim()
    // A cached track with a FRESH lease plays from disk with no connection; anything else
    // (uncached, or an expired lease) needs the live stream, so revive the link - which
    // re-authorizes and renews the lease.
    if (!(audioCache.has(trackId) && leaseValid())) await ensureConnected()
    return { url: shim.urlFor(trackId), port: shimPort }
  },

  // --- storage / offline cache (milestone 3, phase 5B) ------------------------
  cacheStats () {
    return { bytes: audioCache.totalBytes(), count: audioCache.count(), cap: audioCache.cap }
  },

  clearCache () {
    audioCache.clear()
    log('cache:cleared')
    return { bytes: 0, count: 0, cap: audioCache.cap }
  },

  setCacheCap ({ bytes }) {
    const cap = Math.max(0, Number(bytes) || 0)
    const s = loadSettings()
    s.cacheCap = cap
    saveSettings(s)
    audioCache.setCap(cap) // may evict immediately if the new cap is smaller
    return { bytes: audioCache.totalBytes(), count: audioCache.count(), cap }
  },

  // --- pinned albums / Downloads (milestone 3, phase 5C) ----------------------
  //
  // Download an album for offline: fetch its tracks, pull each in full, and mark them
  // pinned so LRU eviction never touches them. Already-cached tracks are reused (a replay
  // that filled the LRU counts), and a retry after an interruption skips what is done -
  // so it is resumable at the track grain. Progress is emitted per track.
  async pinAlbum ({ albumId }) {
    const s = loadSettings()
    if (networkType === 'cellular' && !s.downloadCellular) {
      throw new Error('Downloads are off on cellular. Turn on "Download over cellular" in Settings, or join Wi-Fi.')
    }
    await ensureConnected()
    const album = await client.get({ id: albumId, type: 'album' })
    if (!album) throw new Error('That album is not available.')
    const tracks = album.tracks || []
    // Store the track METADATA, not just ids - so a downloaded album renders and plays
    // with no host (the whole point of a download). Art falls back to the album cover.
    const meta = tracks.map(t => ({
      id: t.id, title: t.title, artist: t.artist || null, album: t.album || album.name,
      track: t.track ?? null, durationMs: t.durationMs ?? null,
      coverId: t.coverId || album.coverId || album.coverArt || null,
      suffix: t.suffix || null, size: t.size || 0
    }))

    const pins = loadPins()
    pins[albumId] = {
      id: albumId, name: album.name, artist: album.artist || null,
      coverId: album.coverId || album.coverArt || null,
      tracks: meta, addedAt: Date.now(), complete: false
    }
    savePins(pins)
    emit('pin:progress', { albumId, done: 0, total: tracks.length })

    let done = 0
    for (const t of tracks) {
      try {
        if (!audioCache.has(t.id)) {
          const mime = mimeFor(t.suffix ? 'a.' + t.suffix : (t.path || t.title || ''))
          const sink = audioCache.createSink(t.id, { mime, size: t.size })
          await client.streamTo({ trackId: t.id }, (chunk) => sink.write(chunk))
          if (!await sink.commit()) throw new Error('incomplete download')
        }
        audioCache.setPinned(t.id, true)
      } catch (e) {
        log('pin:track-failed', { err: e?.message })
        emit('pin:error', { albumId, err: e?.message })
        throw e // leave what completed; the album stays incomplete and a retry resumes
      }
      emit('pin:progress', { albumId, done: ++done, total: tracks.length })
    }

    // Cache the COVERS too, so the download shows its real art offline instead of a
    // placeholder. Best-effort and purely cosmetic: a cover that fails to fetch never
    // fails the download. Distinct coverIds only (album + tracks, usually just one),
    // fetched at the size the Downloads views request.
    const covers = new Set()
    if (album.coverId || album.coverArt) covers.add(album.coverId || album.coverArt)
    for (const m of meta) if (m.coverId) covers.add(m.coverId)
    for (const coverId of covers) {
      if (artStore.has(coverId)) continue
      try {
        // Store at the size the shim serves from disk (DEFAULT_ART_SIZE) so the two stay
        // in lockstep - that is the size the Downloads views request.
        const buf = await client.art({ coverId, size: DEFAULT_ART_SIZE })
        artStore.put(coverId, buf)
      } catch (e) { log('pin:art-failed', { err: e?.message }) }
    }

    const p = loadPins()
    if (p[albumId]) { p[albumId].complete = true; savePins(p) }
    emit('pin:done', { albumId })
    log('pin:album', { count: tracks.length })
    return { ok: true, count: tracks.length }
  },

  async unpinAlbum ({ albumId }) {
    const pins = loadPins()
    const p = pins[albumId]
    if (p) {
      delete pins[albumId]
      for (const tid of (p.tracks || []).map(t => t.id)) {
        // Free the bytes unless another pinned album still needs them (shared tracks are
        // rare, but source-scoped ids can overlap on compilations).
        const neededElsewhere = Object.values(pins).some(o => (o.tracks || []).some(t => t.id === tid))
        if (!neededElsewhere) audioCache.remove(tid)
      }
      // Free this album's covers too, unless another pinned album still shows them.
      const covers = new Set()
      if (p.coverId) covers.add(p.coverId)
      for (const t of (p.tracks || [])) if (t.coverId) covers.add(t.coverId)
      for (const coverId of covers) {
        const stillUsed = Object.values(pins).some(o =>
          o.coverId === coverId || (o.tracks || []).some(t => t.coverId === coverId))
        if (!stillUsed) artStore.remove(coverId)
      }
      savePins(pins)
      log('unpin:album', { albumId })
    }
    return { ok: true }
  },

  // The Downloads list: the pinned albums, newest first, resolved for rendering.
  downloads () {
    const pins = loadPins()
    const items = Object.values(pins)
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .map(p => ({
        id: p.id, name: p.name, artist: p.artist, count: (p.tracks || []).length,
        complete: p.complete !== false, ...withArt({ coverId: p.coverId })
      }))
    return { items }
  },

  // One downloaded album, straight from the pin registry (no host) - so it renders and
  // plays offline, from a cold launch. Tracks carry loopback art URLs; the shim serves
  // the audio from disk.
  downloadDetail ({ albumId }) {
    const p = loadPins()[albumId]
    if (!p) return null
    return {
      id: p.id, name: p.name, artist: p.artist, coverId: p.coverId,
      art: p.coverId && shim ? shim.artUrlFor(p.coverId) : null,
      complete: p.complete !== false,
      tracks: (p.tracks || []).map(withArt)
    }
  },

  // The set of pinned album ids, so an album screen can show Download vs Downloaded.
  pinnedAlbums () {
    return { ids: Object.keys(loadPins()) }
  },

  setDownloadCellular ({ on }) {
    const s = loadSettings()
    s.downloadCellular = !!on
    saveSettings(s)
    return { downloadCellular: s.downloadCellular }
  },

  // Unpair. Forgets the host and drops the connection.
  //
  // Note what this does NOT do: it does not touch the device identity. The
  // keypair stays, so re-pairing to the same host reuses the same grant row
  // rather than littering the operator's dashboard with a new device every time
  // someone unpairs and pairs again. The host still holds the old grant; it can
  // revoke it if it wants the row gone.
  async forget () {
    try {
      fs.unlinkSync(HOSTS_FILE)
    } catch {}

    // Unpair is a deliberate goodbye: wipe every local copy (downloads, cached state,
    // the lease). This is the reliable purge point a reconnect failure could never be.
    purgeAll()

    // Close the shim's HTTP server, not just the reference. Dropping the
    // reference alone would leave the loopback port bound for the life of the
    // process, and the next pair would open a second one.
    if (shim) {
      try {
        await shim.close()
      } catch {}
    }
    shim = null
    shimPort = null

    if (client) await client.close()
    client = null
    currentHost = null

    log('host:forgotten')
    return { ok: true }
  }
}

// --- IPC loop ---------------------------------------------------------------

let buf = ''
BareKit.IPC.on('data', async (data) => {
  buf += b4a.toString(data)
  const lines = buf.split('\n')
  buf = lines.pop()

  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }

    const fn = methods[msg.method]
    if (!fn) {
      send({ id: msg.id, error: `unknown method: ${msg.method}` })
      continue
    }

    try {
      const result = await fn(msg.args || {})
      send({ id: msg.id, result })
    } catch (e) {
      log('method:failed', { method: msg.method, err: e.message })
      send({ id: msg.id, error: e.message })
    }
  }
})

log('worklet:loaded')
emit('ready', {})
