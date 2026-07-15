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
const { createAudioShim } = require('../worklet/shim')
const { streamParams } = require('../worklet/quality')
const { isPairLink } = require('../protocol/link')
const { coalesce, clientCall } = require('../worklet/outbox')

const DATA_DIR = Bare.argv[0] || '/tmp/peartune'
const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json')
const HOSTS_FILE = path.join(DATA_DIR, 'hosts.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
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

const DEFAULT_SETTINGS = { theme: 'system', deviceName: '', userName: '', streamQuality: 'auto' }

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

// --- connection -------------------------------------------------------------

async function ensureClient () {
  if (client) return client
  client = new PearTuneClient({ keyPair: identity, log })
  return client
}

async function connectTo (host) {
  await ensureClient()
  await client.connect({ hostKey: host.hostKey, libraryId: host.libraryId })
  currentHost = host
  connected = true

  // The shim outlives any single connection, and is only pointed at the new
  // client. It must KEEP ITS PORT: the player is holding
  // http://127.0.0.1:<port>/t/<id> URLs for the whole queue, and a fresh shim gets
  // a fresh port (it listens on 0), so a paused queue would resume into a dead
  // socket. Playback still flows THROUGH the live connection, which is what makes
  // a revoke stop the music.
  if (!shim) {
    // `ensure` is how the shim reaches back for a live connection. It matters for
    // the one path the UI cannot help with: the phone is asleep, the queue is
    // paused, the link has died, and the user presses play on their LOCK SCREEN.
    // Nothing on our side is awake to notice - the request simply arrives on the
    // loopback server, and it has to be able to fix the connection itself.
    shim = createAudioShim({
      client,
      log,
      ensure: ensureConnected,
      // Read fresh each request so a Settings change (or a wifi->cellular flip) applies
      // to the next track without rebuilding the shim.
      quality: () => streamParams(loadSettings(), networkType)
    })
    shimPort = await shim.listen()
  } else {
    shim.setClient(client)
  }

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
      try {
        await connectTo(host)
        state.connected = true
        state.shimPort = shimPort
        state.artBase = shim.artBase()
      } catch (e) {
        log('init:connect-failed', { err: e.message })
        // Paired but unreachable is a normal state, not an error: the Umbrel may
        // simply be off. The UI says so rather than pretending we never paired.
        state.error = e.message
      }
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
  async tracks ({ cursor = 0, limit = 100 } = {}) {
    await ensureConnected()
    const page = await client.list({ type: 'tracks', cursor, limit })
    return { ...page, items: page.items.map(withArt) }
  },

  // Album browsing is the primary way in. A flat list of 1358 tracks is not a
  // music app, and Subsonic has no "all songs" call anyway - so the flat list
  // could only ever show the first page. Albums page properly.
  async albums ({ cursor = 0, limit = 60 } = {}) {
    await ensureConnected()
    const page = await client.list({ type: 'albums', cursor, limit })
    return { ...page, items: page.items.map(withArt) }
  },

  async album ({ id }) {
    await ensureConnected()
    const a = await client.get({ id, type: 'album' })
    return a ? withBigArt(a) : null
  },

  // Artists are the second way in. The host has always been able to list them
  // (`library.list({type:'artists'})`); nothing was asking.
  async artists () {
    await ensureConnected()
    const page = await client.list({ type: 'artists' })
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
    await ensureConnected()
    return { url: shim.urlFor(trackId), port: shimPort }
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
