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

const HyperDHT = require('hyperdht')
const { PearTuneClient } = require('../client')
const { createAudioShim, mimeFor, DEFAULT_ART_SIZE } = require('../worklet/shim')
const { streamParams } = require('../worklet/quality')
const { isPairLink } = require('../protocol/link')
const hostList = require('../worklet/hosts')
const merge = require('../worklet/merge')
const catalog = require('../worklet/catalog')
const { coalesce, clientCall } = require('../worklet/outbox')
const leaves = require('../worklet/leaves')
const retry = require('../worklet/retry')
const { AudioCache } = require('../worklet/cache')
const { ArtStore } = require('../worklet/art-cache')

const DATA_DIR = Bare.argv[0] || '/tmp/peartune'
const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json')
const HOSTS_FILE = path.join(DATA_DIR, 'hosts.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
// Undelivered "I am leaving" messages (worklet/leaves.js). At the ROOT, not under the
// library: removing a library deletes that directory, which is precisely when this is
// written.
const LEAVES_FILE = path.join(DATA_DIR, 'pending-leaves.json')

// PER-HOST state lives under DATA_DIR/lib/<libraryId>/ (multi-host, proposal 2026-07-19),
// so switching libraries shows the right favorites, queue, playlists, pins, lease and
// outbox instead of one host's state bleeding into another's. The AUDIO and ART blob
// caches deliberately stay SHARED at the root (see AUDIO_DIR/ART_DIR below): their ids are
// already namespaced by libraryId (protocol/ids.js) so nothing collides, the bytes de-dupe,
// and - crucially - a track that is mid-play when you switch keeps streaming from the same
// cache. A switch swaps the queue but never stops the music.
const LIB_ROOT = path.join(DATA_DIR, 'lib')
let activeLibraryId = null
function libDir () {
  if (!activeLibraryId) throw new Error('No active library.')
  return path.join(LIB_ROOT, activeLibraryId)
}

// The MERGED view (multi-host step 2, proposal 2026-07-19): when on, browse/search/streaming serve
// from the in-memory merged INDEX (every connected host's catalog, deduped) instead of a single
// host's client. It is a MODE FLAG, deliberately DECOUPLED from activeLibraryId: activeLibraryId
// still names the single client's host (so the single-client-dependent "You" features - favorites,
// resume, counts, session - keep working against the active host in merged mode, the proposal's
// "per-filter for now"), while mergedMode governs the blended browse. Tying merged mode to
// activeLibraryId would break the moment any ensureConnected() -> connectTo() -> useLibrary(realHost)
// fired (a favorites/resume call), silently dropping us out of merged mode mid-session. The reserved
// '_merged' dir still holds merged-only state: the cached index and the mixed-host queue.
const MERGED_ID = '_merged'
let _mergedMode = false
function mergedMode () { return _mergedMode }

// The persisted PLAY QUEUE, so a force-stop or a relaunch does not lose it. Holds
// track IDs + render metadata (the shell's toQueue shape) + index + position +
// shuffle/repeat - NEVER the loopback URLs, which carry the shim's port and change
// every launch. On boot the shell rebuilds the paused queue and re-resolves URLs.
// In merged mode the queue is MIXED-host and lives in lib/_merged/ (proposal §6), separate from
// every single host's queue, so switching between merged and a single library never crosses them.
const queueFile = () => path.join(mergedMode() ? path.join(LIB_ROOT, MERGED_ID) : libDir(), 'queue.json')
// A read-through cache of THIS device's favorite trackIds. The host is the source of
// truth (host-as-hub); this only lets the hearts render instantly and offline. Writes
// still go to the host (favorites need a connection in Phase 1).
const favoritesFile = () => path.join(libDir(), 'favorites.json')
// A read-through cache of THIS device's playlist SUMMARIES ([{ id, name, count }]), so
// the Playlists list renders instantly and offline. The host owns the truth; a
// playlist's tracks and every edit still need a connection (Phase 4, like favorites).
const playlistsFile = () => path.join(libDir(), 'playlists.json')
// The offline write-queue: state writes (favorite / resume / count) made while the host
// was unreachable, replayed in order on the next connect (milestone 3, phase 5).
const outboxFile = () => path.join(libDir(), 'outbox.json')
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
const leaseFile = () => path.join(libDir(), 'lease.json')
const LEASE_GRACE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days
// The PINNED-ALBUM registry (milestone 3, phase 5C): what the user explicitly downloaded,
// separate from the auto-LRU cache. Maps albumId -> { id, name, artist, coverId, tracks,
// addedAt, complete } - `tracks` being the track METADATA, so a download still renders with
// no host. The bytes live in the audio cache (marked pinned); this is the
// human-facing list the Downloads view shows and unpins.
const pinsFile = () => path.join(libDir(), 'pins.json')

const DEFAULT_SETTINGS = {
  theme: 'system', deviceName: '', userName: '', avatar: '', streamQuality: 'auto',
  cacheCap: DEFAULT_CACHE_CAP, downloadCellular: false
}

// What the network is right now, as reported by the shell (expo-network). Default
// 'wifi' - the safe assumption, because wifi means original quality, i.e. no surprise
// transcode and no surprise data use until we actually know we are on cellular.
let networkType = 'wifi'

// ONE HyperDHT node for the whole worklet, reused across every client instance. A client is
// torn down and rebuilt on each reconnect and library switch; if each made (and destroyed)
// its OWN dht node, every reconnect would dial from a COLD, un-bootstrapped node - and the
// first connect off a cold node races its own bootstrap and fails fast as a "host refused"
// (then the retry, off the now-warm node, succeeds). Sharing one warm node fixes that
// transient at the source and makes every reconnect faster. Passed to PearTuneClient, so its
// close() leaves the node alone (_ownDht=false); we only destroy it on a full account reset.
let dht = null
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
// Handoff support is tracked PER HOST, not app-wide. A host that answers ENOMETHOD to a session
// RPC is remembered as unsupported by its libraryId, so ONE stale host in a blended library (or a
// host we've since switched away from in single mode) can no longer disable the handoff for every
// other host - the bug of a single global flag that went false on the first old host and never
// came back. Unknown or offline (no target lib) = assume supported, so the "Playing on <name>"
// card doesn't flicker off before we've actually heard an ENOMETHOD from that host.
const sessionUnsupported = new Set() // libraryIds whose host answered ENOMETHOD to a session RPC
function sessionSupportedFor (lib) { return !lib || !sessionUnsupported.has(lib) }
function markSessionUnsupported (lib) { if (lib) sessionUnsupported.add(lib) }

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

// The paired-host LIST (multi-host, 2026-07-19). hosts.json holds the canonical v2 shape
// { version, hosts:[{hostKey,libraryId,libraryName,addedAt}], activeHostKey }; the pure list
// logic (including the v1 single-object upgrade) lives in worklet/hosts.js so it is tested
// without a disk. Here we just read/normalize and write.
function loadHostsFile () {
  try {
    return hostList.normalize(JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')))
  } catch {
    return hostList.empty()
  }
}

function saveHostsFile (f) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(HOSTS_FILE, JSON.stringify(f))
}

// The currently-active host object, or null. Everything that used to call loadHost() (one
// host) now asks for the active one.
function loadActiveHost () {
  return hostList.activeHost(loadHostsFile())
}

// Adopt a library as the active one: point activeLibraryId at it, ensure its per-host dir
// exists, migrate any pre-multi-host flat files into it, and (re)load its outbox. Cheap and
// idempotent - a no-op when the library is already active - so connect/init/switch can all
// call it freely. Called BEFORE any per-host state read/write.
function useLibrary (libraryId) {
  if (activeLibraryId === libraryId) return
  activeLibraryId = libraryId
  fs.mkdirSync(libDir(), { recursive: true })
  // The legacy flat-file migration only makes sense for a REAL host (the pre-multi-host layout held
  // one host's state); never fold root files into the _merged context.
  if (libraryId !== MERGED_ID) migrateLegacyState()
  outbox = loadOutbox()
}

// One-time upgrade from the pre-multi-host flat layout: the six per-host state files used to
// sit directly in DATA_DIR. On the first load under multi-host there is exactly one host (the
// v1 file upgraded to a one-element list), so move those files into ITS lib dir. Idempotent:
// a file already migrated (or never present) is skipped; a dest that somehow exists is left
// untouched and the stray root copy is dropped. The shared audio/art dirs are NOT touched -
// they stay at the root by design.
function migrateLegacyState () {
  for (const n of ['queue.json', 'favorites.json', 'playlists.json', 'outbox.json', 'lease.json', 'pins.json']) {
    const from = path.join(DATA_DIR, n)
    let data
    try { data = fs.readFileSync(from) } catch { continue } // nothing at the root to migrate
    let destExists = true
    try { fs.statSync(path.join(libDir(), n)) } catch { destExists = false }
    if (!destExists) fs.writeFileSync(path.join(libDir(), n), data)
    try { fs.unlinkSync(from) } catch {}
    log('lib:migrated', { file: n })
  }
}

// Remove ONE library's local state: delete its per-host dir, and reclaim its downloaded
// audio from the SHARED cache. Track ids are host-unique (namespaced by libraryId), so a
// removed host's cached/pinned bytes are unambiguously its own and safe to drop; its plain
// LRU entries that we do not have listed just age out under the cap. Does not touch identity
// or other libraries.
function purgeLibrary (libraryId) {
  const dir = path.join(LIB_ROOT, libraryId)
  try {
    const pins = JSON.parse(fs.readFileSync(path.join(dir, 'pins.json'), 'utf8'))
    for (const alb of Object.values(pins || {})) {
      // `tracks` is what pinAlbum writes: the track METADATA, so a download renders with no
      // host. This used to read `alb.trackIds`, which pins.json has never contained (only the
      // comment on pinsFile said so), so the loop silently dropped nothing and removing a
      // library left its DOWNLOADED audio on disk with no way left to reach it.
      const ids = (alb.tracks || []).map(t => t && t.id).filter(Boolean)
      for (const tid of (ids.length ? ids : (alb.trackIds || []))) { try { audioCache.remove(tid) } catch {} }
    }
    // remove() does not persist (see cache.js), so without this the rows come back on the
    // next launch pointing at files that are gone.
    try { audioCache.save() } catch {}
  } catch {}

  // The STREAMED audio, which the pins list above cannot see. Entries written before the
  // library tag existed have none and are deliberately left alone - claiming them would risk
  // deleting another library's cache - so they keep ageing out under the LRU cap as before.
  try {
    const { removed, bytes, untagged } = audioCache.removeLibrary(libraryId)
    if (removed || untagged) log('local:audio-purged', { library: libraryId.slice(0, 8), removed, bytes, untagged })
  } catch {}
  for (const n of ['queue.json', 'favorites.json', 'playlists.json', 'outbox.json', 'lease.json', 'pins.json']) {
    try { fs.unlinkSync(path.join(dir, n)) } catch {}
  }
  try { fs.rmdirSync(dir) } catch {}
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
    const o = JSON.parse(fs.readFileSync(favoritesFile(), 'utf8'))
    return { track: o.track || [], album: o.album || [], artist: o.artist || [] }
  } catch {
    return { track: [], album: [], artist: [] }
  }
}

function saveFavCache (g) {
  fs.mkdirSync(libDir(), { recursive: true })
  fs.writeFileSync(favoritesFile(), JSON.stringify({
    track: g.track || [], album: g.album || [], artist: g.artist || []
  }))
}

// The MERGED favorites cache (phase 2): the UNION of every host's favorites, cached at lib/_merged so
// the blended hearts render instantly + offline. Favourites are host-as-hub (each host stores THIS
// device's favorites for its own items), so the blend is just their union - an id is favorited iff any
// host that owns it says so.
const mergedFavFile = () => path.join(LIB_ROOT, MERGED_ID, 'favorites.json')
function loadMergedFavCache () {
  try {
    const o = JSON.parse(fs.readFileSync(mergedFavFile(), 'utf8'))
    return { track: o.track || [], album: o.album || [], artist: o.artist || [] }
  } catch {
    return { track: [], album: [], artist: [] }
  }
}
function saveMergedFavCache (g) {
  try {
    fs.mkdirSync(path.join(LIB_ROOT, MERGED_ID), { recursive: true })
    fs.writeFileSync(mergedFavFile(), JSON.stringify({ track: g.track || [], album: g.album || [], artist: g.artist || [] }))
  } catch {}
}
function applyMergedFav (kind, id, on) {
  const cache = loadMergedFavCache()
  const set = new Set(cache[kind] || [])
  if (on) set.add(id); else set.delete(id)
  cache[kind] = [...set]
  saveMergedFavCache(cache)
}

// Same disposable-mirror deal for playlist summaries.
function loadPlaylistCache () {
  try {
    const o = JSON.parse(fs.readFileSync(playlistsFile(), 'utf8'))
    return Array.isArray(o) ? o : []
  } catch {
    return []
  }
}

function savePlaylistCache (items) {
  fs.mkdirSync(libDir(), { recursive: true })
  fs.writeFileSync(playlistsFile(), JSON.stringify(items || []))
}

// --- offline write-queue (milestone 3, phase 5) -----------------------------
//
// A state write that fails because the host is unreachable is queued to disk and
// replayed, in order, the next time we connect. The coalescing (a favorite/resume keeps
// only its latest, a play count accumulates) lives in worklet/outbox.js so it is testable;
// here we just persist it and drive the client.
// Loaded per-active-library by useLibrary() - an unsent write targets a SPECIFIC host, so
// it must not leak across a switch. Empty until a library is adopted.
let outbox = []
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
    const o = JSON.parse(fs.readFileSync(outboxFile(), 'utf8'))
    return Array.isArray(o) ? o : []
  } catch {
    return []
  }
}

function saveOutbox () {
  fs.mkdirSync(libDir(), { recursive: true })
  fs.writeFileSync(outboxFile(), JSON.stringify(outbox))
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

// Per-host outboxes for MERGED mode: a state write (favorite/resume/count) to an OWNING host that's
// offline queues to THAT host's own outbox (lib/<libraryId>/outbox.json) and flushes when that host
// (re)connects. Distinct from the single-active `outbox` var above (single-host mode); here writes fan
// out across hosts, so each host keeps its own queue.
const outboxFileFor = (libraryId) => path.join(LIB_ROOT, libraryId, 'outbox.json')
function loadOutboxFor (libraryId) {
  try { const o = JSON.parse(fs.readFileSync(outboxFileFor(libraryId), 'utf8')); return Array.isArray(o) ? o : [] } catch { return [] }
}
function enqueueFor (libraryId, method, params) {
  if (!libraryId) return
  const next = coalesce(loadOutboxFor(libraryId), { method, params })
  try {
    fs.mkdirSync(path.join(LIB_ROOT, libraryId), { recursive: true })
    fs.writeFileSync(outboxFileFor(libraryId), JSON.stringify(next))
  } catch {}
  log('outbox:queued', { lib: String(libraryId).slice(0, 8), method, depth: next.length })
}
const flushingLibs = new Set()
async function flushOutboxFor (libraryId, c) {
  if (!c || !libraryId || flushingLibs.has(libraryId)) return
  let q = loadOutboxFor(libraryId)
  if (!q.length) return // nothing queued for this host - don't churn on every connect
  flushingLibs.add(libraryId)
  try {
    while (q.length) {
      const call = clientCall(c, q[0])
      if (!call) { q = q.slice(1) } // unknown method: drop it
      else {
        try { await call() } catch { break } // still can't reach the host; keep this + the rest
        q = q.slice(1)
      }
      try { fs.writeFileSync(outboxFileFor(libraryId), JSON.stringify(q)) } catch {}
    }
    if (!q.length) log('outbox:drained', { lib: String(libraryId).slice(0, 8) })
  } finally {
    flushingLibs.delete(libraryId)
  }
}

// --- the offline lease (phase 5B) -------------------------------------------
function loadLastAuth () {
  try { return Number(JSON.parse(fs.readFileSync(leaseFile(), 'utf8')).lastAuth) || 0 } catch { return 0 }
}
// Stamp a specific library's lease. Merged mode connects several hosts at once, each renewing
// its OWN lease, so this takes a libraryId rather than assuming the single active one.
function stampAuthFor (libraryId) {
  try {
    const dir = path.join(LIB_ROOT, libraryId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'lease.json'), JSON.stringify({ lastAuth: Date.now() }))
  } catch {}
}
function stampAuth () { stampAuthFor(activeLibraryId) }
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
    const o = JSON.parse(fs.readFileSync(pinsFile(), 'utf8'))
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}
function savePins (pins) {
  fs.mkdirSync(libDir(), { recursive: true })
  fs.writeFileSync(pinsFile(), JSON.stringify(pins))
}

// Full account reset: wipe EVERY local copy - the shared audio/art blob caches plus every
// paired library's per-host dir (favorites, playlists, queue, unsent writes, lease, pins).
// Used by forget() (a deliberate goodbye) - NOT on a reconnect failure, which cannot tell a
// revoke from a server that is simply off. Per-host removal (one library, identity kept)
// goes through purgeLibrary() instead.
function purgeAllLibraries (libraryIds) {
  try { audioCache.clear() } catch {}
  try { artStore.clear() } catch {}
  for (const id of libraryIds) purgeLibrary(id)
  outbox = []
  log('local:purged')
}

// --- connection -------------------------------------------------------------

// Build ONE PearTuneClient off the shared warm DHT node. Every connection - the single active
// one and every merged-mode pool connection - is made here so they all share the DHT and the
// session-superseded push wiring.
function makeClient () {
  if (!dht) dht = new HyperDHT()
  const c = new PearTuneClient({ keyPair: identity, dht, log })

  // Instant presence: the host pushes 'session-superseded' the moment another of this
  // person's devices claims the play token, so we stop NOW instead of waiting for our next
  // heartbeat to come back ok:false (lazy presence). Same effect as a rejected heartbeat -
  // drop the token and tell the shell to hand off - just immediate. The shell's onHandedOff
  // is idempotent, so a later lazy rejection landing too is harmless.
  c.onPush = (m) => {
    if (m?.kind === 'session-superseded') {
      sessionActive = false
      if (m.data?.generation) sessionGen = m.data.generation
      log('session:superseded', { generation: m.data?.generation ?? null })
      emit('session:superseded', {})
    } else if (m?.kind === 'library-renamed') {
      // The operator renamed the library on this host's dashboard; the host pushed it to every live
      // connection (host/presence.js notifyAll). Self-describing via libraryId, so this updates the
      // RIGHT stored host record - active OR a non-active pool host - the instant it happens, not on
      // the next reconnect/rebuild. Same effect as syncHostNames, just push-driven. The UI relabels
      // the header/switcher/merged chips off host:renamed for any hostKey.
      const lib = m.data?.libraryId
      const name = m.data?.libraryName
      const rec = lib && loadHostsFile().hosts.find((x) => x.libraryId === lib)
      if (rec && name && rec.libraryName !== name) {
        saveHostsFile(hostList.renameHost(loadHostsFile(), rec.hostKey, name))
        log('host:renamed-push', { hostKey: rec.hostKey })
        emit('host:renamed', { hostKey: rec.hostKey, libraryName: name })
      }
    }
  }
  return c
}

async function ensureClient () {
  if (client) return client
  client = makeClient()
  return client
}

// --- multi-host connection pool (step 2, merged mode) -----------------------
//
// Merged mode reads from ALL paired hosts at once - to build the merged catalog index and to
// route streaming per track. Each pool entry is a READ connection to one host, kept SEPARATE
// from the single active `client` (which still serves single-host/filtered mode and the shim).
// libraryId -> { client, host, reconnecting }. Offline hosts are simply absent from the pool -
// not an error (see ensureAll). The pool shares the one warm DHT node, so N connections are
// cheap.
const pool = new Map()

// The merged, deduped library INDEX (proposal 2026-07-19, §2): every connected host's full catalog,
// merged in memory, that merged mode serves browse/search/sort from. Null until first built.
// `mergedConnected` is the set of libraryIds that actually contributed to THIS index - a host that
// was offline at build time is simply absent (its tracks greyed), and it's what bestCopy() checks to
// route streaming (slice 4) to a copy that's actually reachable.
let mergedIndex = null
let mergedConnected = new Set()
let rebuildingIndex = null // single-flight: a burst of browse calls entering merged mode shares ONE build
// Routing lookups derived from the index (step 2, slice 4): map a bare trackId/coverId back to its
// owning host, so a play/art request in merged mode (whose URL may carry no libraryId, e.g. the UI's
// own artBase covers) still reaches the right server. trackByAnyId keys EVERY copy's id to the
// merged track, so bestCopy can fail the stream over to another host when the primary is offline.
let coverLib = new Map() // coverId -> libraryId
let trackLib = new Map() // any copy's trackId -> libraryId
let trackByAnyId = new Map() // any copy's trackId -> the merged track (for best-copy failover)
let entityLib = new Map() // any album/artist/genre id (primary or a copy) -> its owning libraryId

function poolClient (libraryId) {
  const e = pool.get(libraryId)
  return e && e.client && e.client.conn && !e.client.conn.destroyed ? e.client : null
}

// Ensure ONE host in the pool is connected; returns its client. Single-flight per host (a burst
// of merged reads shares one dial), and self-heals a dropped connection like ensureConnected.
async function ensureHost (host) {
  const libId = host.libraryId
  const live = poolClient(libId)
  if (live) return live

  let e = pool.get(libId)
  if (!e) { e = { client: null, host, reconnecting: null }; pool.set(libId, e) }
  e.host = host

  if (!e.reconnecting) {
    e.reconnecting = (async () => {
      if (e.client) { try { await e.client.close() } catch {} ; e.client = null }
      const c = makeClient()
      await c.connect({ hostKey: host.hostKey, libraryId: host.libraryId })
      e.client = c
      stampAuthFor(libId) // a successful connect is a fresh authorization for THIS host's lease
      // Drain anything queued for this host while it was offline (merged favorite/resume/count writes).
      // Fire-and-forget - a slow flush must not hold up the connect or the reads waiting on it.
      flushOutboxFor(libId, c).catch(() => {})
      c.conn.once('close', () => {
        if (e.client === c) e.client = null
        // A pool connection dropping (a revoke of THIS host, or it going offline) has no other
        // channel to the UI - host:disconnected only fires for the single active client. In merged
        // mode, push fresh status so the chip + Settings row grey promptly, whichever host it was.
        if (mergedMode()) emit('merged:updated', mergedStatusData())
        // ...and then TRY TO GET IT BACK, which nothing used to do for a pool host.
        schedulePoolReconnect(e.host)
      })
      return c
    })().finally(() => { e.reconnecting = null })
  }
  await e.reconnecting
  return e.client
}

// Connect EVERY paired host in parallel for a merged read. An offline host resolves to a
// rejection (allSettled), so it's absent from the merge rather than failing the whole thing.
// Returns the libraryIds that connected.
async function ensureAll () {
  const hosts = loadHostsFile().hosts
  const settled = await Promise.allSettled(hosts.map((h) => ensureHost(h).then(() => h.libraryId)))
  return settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
}

async function closePool () {
  // Cancel FIRST: closing a client fires its close handler, which would otherwise schedule a
  // retry for a pool we are in the middle of tearing down.
  cancelAllPoolReconnects()
  for (const e of pool.values()) { try { if (e.client) await e.client.close() } catch {} }
  pool.clear()
}

// Best-effort self-leave (proposal 2026-07-20): tell a host we're removing that this device is
// leaving, so it drops our OWN grant and cuts us - "remove library" then actually ends access
// there instead of leaving a live grant + stale dashboard row. Only when currently connected;
// swallow ENOMETHOD (an old host), offline, or the connection closing as the host cuts us. Time-
// boxed so a half-dead connection can never block the local removal, which must always proceed.
// Returns TRUE only if the host actually got the message. The caller needs to know: an
// undelivered leave is queued and retried later (worklet/leaves.js) instead of being lost,
// which is what stops an offline removal leaving a live grant on someone's dashboard.
async function leaveHostBestEffort (libraryId) {
  const c = poolClient(libraryId) || (currentHost?.libraryId === libraryId ? client : null)
  if (!c || !c.conn || c.conn.destroyed) return false
  try {
    // The timeout branch resolves `false`: a half-dead connection must never block the
    // local removal, but nor may it be mistaken for a delivered leave.
    return await Promise.race([
      c.deviceLeave().then(() => true, () => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000))
    ])
  } catch {
    return false
  }
}

function loadLeaves () {
  try {
    return leaves.normalize(JSON.parse(fs.readFileSync(LEAVES_FILE, 'utf8')))
  } catch {
    return []
  }
}

function saveLeaves (list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(LEAVES_FILE, JSON.stringify(list))
  } catch {}
}

// Retry the leaves we could not deliver at removal time. Fire-and-forget from init: each
// one dials its host on a THROWAWAY client (that library is gone from hosts.json, so it
// must not touch the active connection or the merged pool), says device.leave, and drops
// out of the queue. A host that is still unreachable just stays queued until it answers or
// the entry ages out.
async function flushPendingLeaves () {
  let list = leaves.expire(loadLeaves())
  saveLeaves(list)
  if (!list.length) return
  log('leaves:flushing', { pending: list.length })

  for (const entry of list) {
    let c = null
    try {
      c = makeClient()
      await c.connect({ hostKey: entry.hostKey, libraryId: entry.libraryId })
      await c.deviceLeave()
      list = leaves.dropLeave(list, entry.hostKey)
      log('leaves:delivered', { host: entry.hostKey.slice(0, 8) })
    } catch (e) {
      list = leaves.bumpAttempt(list, entry.hostKey)
      log('leaves:deferred', { host: entry.hostKey.slice(0, 8), err: e?.message })
    }
    try { if (c) await c.close() } catch {}
    saveLeaves(leaves.expire(list))
  }
}

// --- the merged index (step 2, proposal 2026-07-19 §2) ----------------------
//
// Rebuilt on entering merged mode and on a host reconnect/rescan: connect every paired host
// (ensureAll - offline ones absent), pull each one's FULL catalog off its pool client, and
// merge.buildIndex dedups them into one blended library served from memory. Cached to
// lib/_merged/index.json so a cold launch renders instantly then refreshes in the background.
const mergedDir = () => path.join(LIB_ROOT, MERGED_ID)
const mergedIndexFile = () => path.join(mergedDir(), 'index.json')

// Drop the blend's own state. Every file here is DERIVED from the paired hosts (the cached
// index, and the merged favorites/queue that ride it), so once there is no blend left it is
// describing libraries this device may not even follow any more. purgeLibrary is no use for
// this: it does not know about index.json, so it would leave the biggest file behind and
// then fail to remove the directory.
function purgeMerged () {
  const dir = mergedDir()
  for (const n of ['index.json', 'queue.json', 'favorites.json', 'playlists.json', 'outbox.json', 'lease.json', 'pins.json']) {
    try { fs.unlinkSync(path.join(dir, n)) } catch {}
  }
  try { fs.rmdirSync(dir) } catch {}
}
// When the last rebuild finished. A rebuild re-fetches every host's full catalog (seconds, real
// bandwidth), so the auto-refresh triggers (a reconnect) are rate-limited against this - otherwise a
// permanently-unreachable host (revoked) keeps `some host disconnected` true and every single-client
// reconnect would kick another full rebuild. An explicit pull-to-refresh passes force to bypass it.
let lastIndexBuiltAt = 0
const REBUILD_COOLDOWN_MS = 20000

async function rebuildIndex () {
  if (rebuildingIndex) return rebuildingIndex
  rebuildingIndex = (async () => {
    const libIds = await ensureAll() // connect all; offline hosts absent from this list
    const hosts = loadHostsFile().hosts.filter((h) => libIds.includes(h.libraryId))
    // Pull each connected host's catalog off its pool client. allSettled so one host dropping
    // mid-fetch drops just that host from the blend, not the whole rebuild.
    const settled = await Promise.allSettled(hosts.map((h) => {
      const c = poolClient(h.libraryId)
      if (!c) return Promise.reject(new Error('not connected'))
      return catalog.fetchCatalog(c, h.libraryId)
    }))
    const catalogs = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
    mergedIndex = merge.buildIndex(catalogs)
    mergedConnected = new Set(catalogs.map((c) => c.libraryId))
    lastIndexBuiltAt = Date.now()
    buildRouteMaps()
    // Pick up library RENAMES for EVERY connected host, not just the active one (identity() covers
    // the active host on its own). Done here so the chips + switcher relabel on the same rebuild.
    await syncHostNames(hosts.filter((h) => mergedConnected.has(h.libraryId)))
    try {
      fs.mkdirSync(mergedDir(), { recursive: true })
      fs.writeFileSync(mergedIndexFile(), JSON.stringify({
        builtAt: Date.now(), connected: [...mergedConnected], index: mergedIndex
      }))
    } catch {}
    log('merged:index', {
      libraries: mergedConnected.size,
      artists: mergedIndex.artists.length,
      albums: mergedIndex.albums.length,
      tracks: mergedIndex.tracks.length
    })
    // Tell the UI the blend changed (a background rebuild on launch/reconnect), so it refreshes the
    // browse + the source-filter chips (greying a host that just dropped, un-greying one that joined).
    if (mergedMode()) emit('merged:updated', mergedStatusData())
    return mergedIndex
  })().finally(() => { rebuildingIndex = null })
  return rebuildingIndex
}

// Pick up library RENAMES for the given connected pool hosts (extends the active-host live-rename to
// every host in the blend). Each host's identity.get carries its current name; if it differs from our
// stored record, persist it and tell the UI (chips + switcher relabel). Best-effort per host.
async function syncHostNames (hosts) {
  await Promise.allSettled((hosts || []).map(async (h) => {
    const c = poolClient(h.libraryId)
    if (!c) return
    const remote = await c.getIdentity().catch(() => null)
    const name = remote && remote.libraryName
    const rec = loadHostsFile().hosts.find((x) => x.libraryId === h.libraryId)
    if (name && rec && rec.libraryName !== name) {
      saveHostsFile(hostList.renameHost(loadHostsFile(), rec.hostKey, name))
      emit('host:renamed', { hostKey: rec.hostKey, libraryName: name })
    }
  }))
}

// The paired libraries with the active one flagged (Settings' switcher). A module function so
// methods can call it without `this` - the IPC dispatch invokes methods unbound, so `this` is
// undefined inside them.
function listHostsData () {
  const f = loadHostsFile()
  return {
    hosts: f.hosts.map((h) => ({ ...h, active: h.hostKey === f.activeHostKey })),
    activeHostKey: f.activeHostKey
  }
}

// The per-library status the UI renders the source-filter chips + greying from (see the mergedStatus
// method). A module function so a background rebuildIndex can push it without the methods object.
// `connected` is LIVE pool connectivity (connectedLibs), not the build-time mergedConnected, so a
// revoke - which destroys the pool connection instantly - greys the host the moment the UI re-queries
// (on host:disconnected), without waiting for a full index rebuild. `trackCount` stays index-based:
// how many of the host's tracks are in the CURRENT blend (a host can be greyed/unreachable yet still
// have its last-built tracks browsable).
function mergedStatusData () {
  const hosts = loadHostsFile().hosts
  const live = connectedLibs()
  const perLib = {}
  if (mergedIndex) {
    for (const t of mergedIndex.tracks) {
      for (const c of (t.copies || [])) perLib[c.libraryId] = (perLib[c.libraryId] || 0) + 1
    }
  }
  return {
    merged: mergedMode(),
    libraries: hosts.map((h) => ({
      libraryId: h.libraryId,
      libraryName: h.libraryName,
      connected: live.has(h.libraryId),
      trackCount: perLib[h.libraryId] || 0
    })),
    counts: mergedIndex
      ? { artists: mergedIndex.artists.length, albums: mergedIndex.albums.length, tracks: mergedIndex.tracks.length, genres: mergedIndex.genres.length }
      : null
  }
}

// Load the previous run's cached index so merged mode renders instantly on a cold launch, BEFORE
// the live ensureAll + fetch refresh it. Best-effort; a missing/corrupt cache just means "build it".
function loadCachedIndex () {
  if (mergedIndex) return
  try {
    const o = JSON.parse(fs.readFileSync(mergedIndexFile(), 'utf8'))
    if (o && o.index) { mergedIndex = o.index; mergedConnected = new Set(o.connected || []); buildRouteMaps() }
  } catch {}
}

// (Re)build the trackId/coverId -> owning-host lookups from the current index (step 2, slice 4). A
// coverId maps to the FIRST host seen holding it; a trackId (every copy's id) maps to its own host
// and to the merged track (for failover). Rebuilt whenever the index is.
function buildRouteMaps () {
  coverLib = new Map()
  trackLib = new Map()
  trackByAnyId = new Map()
  entityLib = new Map()
  if (!mergedIndex) return
  const noteCover = (coverId, lib) => { if (coverId && !coverLib.has(coverId)) coverLib.set(coverId, lib) }
  // An entity's own id AND every copy's id map to the owning host, so a detail read (album/artist/
  // genre) routes by id alone - the UI needn't thread libraryId through the nav stack.
  const noteEntity = (e) => {
    if (e.id && !entityLib.has(e.id)) entityLib.set(e.id, e.libraryId)
    for (const c of (e.copies || [])) { noteCover(c.coverId, c.libraryId); if (c.id && !entityLib.has(c.id)) entityLib.set(c.id, c.libraryId) }
  }
  for (const t of mergedIndex.tracks) {
    for (const c of (t.copies || [])) { if (c.id) { trackLib.set(c.id, c.libraryId); trackByAnyId.set(c.id, t) }; noteCover(c.coverId, c.libraryId) }
    noteCover(t.coverId, t.libraryId)
  }
  for (const a of mergedIndex.albums) { noteCover(a.coverId, a.libraryId); noteEntity(a) }
  for (const a of mergedIndex.artists) { noteCover(a.coverId, a.libraryId); noteEntity(a) }
  for (const g of mergedIndex.genres) { noteCover(g.coverId, g.libraryId); noteEntity(g) }
}

// Ensure a usable merged index exists before serving a browse call (a browse can land before the
// first build finishes). Shares rebuildIndex's single-flight.
async function ensureIndex () {
  if (!mergedIndex) await rebuildIndex()
  return mergedIndex
}

// The connected pool client for one host, ensured (self-heals a dropped connection). Used both by a
// DETAIL read (an album's track list the browse index doesn't hold) and by streaming routing.
async function ensureHostById (libraryId) {
  const host = loadHostsFile().hosts.find((h) => h.libraryId === libraryId)
  if (!host) throw new Error('Unknown library.')
  return await ensureHost(host)
}

// The libraryIds with a LIVE pool connection right now (not merely in the last index build) - the
// connected-set bestCopy() checks so streaming routes to a copy that's actually reachable.
function connectedLibs () {
  const s = new Set()
  for (const libId of pool.keys()) if (poolClient(libId)) s.add(libId)
  return s
}

// --- cross-host session home (multi-host phase 3, proposal 2026-07-20) --------
// The merged play session lives on ONE elected host - the smallest-hostKey host that's currently
// connected - so every device coordinates through the same generation-CAS authority (electHome is
// pure + tested in worklet/hosts). The single active host keeps its own per-host session.
function sessionHomeLib () {
  return hostList.electHome(loadHostsFile(), connectedLibs())
}

// Where a session RPC goes, and under which scope. Merged mode -> the elected home host with
// `merged: true`; single mode -> the active client. sessionTarget() is SYNC (reads current pool
// state, used by the ~4s heartbeat so it never dials); sessionReady() ensures the connection first
// (used by activate/takeover/info, which the user just triggered). Either yields c: null offline.
// `lib` is the target host's libraryId - the key handoff support is scoped to (the elected home in
// merged mode, the active host in single mode). Callers gate on sessionSupportedFor(lib).
function sessionTarget () {
  if (mergedMode()) { const lib = sessionHomeLib(); return { c: lib ? poolClient(lib) : null, merged: true, lib } }
  return { c: client, merged: false, lib: currentHost?.libraryId || null }
}
async function sessionReady () {
  if (mergedMode()) { await ensureAll().catch(() => {}); return sessionTarget() }
  await ensureConnected()
  return { c: client, merged: false, lib: currentHost?.libraryId || null }
}

// Tag a session queue item with its owning host, so the receiver routes each track to the host
// that holds it. The receiver's own merged index resolves it too, but a self-describing session
// survives an index that differs slightly between devices. No-op (returns base) in single mode.
function tagSessionItem (base, trackId, merged) {
  if (!merged) return base
  const m = trackByAnyId.get(trackId)
  return m ? { ...base, libraryId: m.libraryId, copies: m.copies } : base
}

// Union every connected host's favorites (phase 2). Returns the merged id sets plus `src` (id -> the
// host that has it) so favoriteItems can resolve each from the right host, and `ok` (any host answered).
async function unionFavs () {
  const libs = [...connectedLibs()]
  const settled = await Promise.allSettled(libs.map((lib) => {
    const c = poolClient(lib)
    return c ? c.favList().then((v) => ({ lib, v })) : Promise.reject(new Error('offline'))
  }))
  const u = { track: new Set(), album: new Set(), artist: new Set() }
  const src = new Map()
  let ok = false
  for (const r of settled) {
    if (r.status !== 'fulfilled' || !r.value || !r.value.v) continue
    ok = true
    const { lib, v } = r.value
    for (const k of ['track', 'album', 'artist']) {
      for (const id of (v[k] || [])) { u[k].add(id); if (!src.has(id)) src.set(id, lib) }
    }
  }
  return { ok, grouped: { track: [...u.track], album: [...u.album], artist: [...u.artist] }, src }
}

// The owning host of a favorite id: a track routes by its copy id; an album/artist by entityLib.
function favHost (kind, id) {
  if (kind === 'track') { const r = routeTrack({ trackId: id }); return r ? r.libraryId : null }
  return entityLib.get(id) || null
}

// The connected pool client for the host that owns a track (merged mode), or null - so per-track
// state writes (resume/count) and reads route to the same host that holds the track.
function trackClient (trackId) {
  const lib = favHost('track', trackId)
  return lib ? poolClient(lib) : null
}

// Resolvers the shim consults for a URL that carries no libraryId (the UI's own artBase covers, or a
// single-segment track URL) - null outside merged mode, so single-host behaviour is unchanged.
function libForTrack (trackId) { return mergedMode() ? (trackLib.get(trackId) || null) : null }
function libForCover (coverId) { return mergedMode() ? (coverLib.get(coverId) || null) : null }
// The owning host of a DETAIL entity (album/artist/genre) by its id, so a detail read routes even
// when the UI didn't thread a libraryId (it just calls album({id})). An explicit libraryId wins.
function libForEntity (id, libraryId) { return libraryId || (mergedMode() ? (entityLib.get(id) || null) : null) }

// Resolve a track to the best CONNECTED copy to stream: { libraryId, id }. Prefers copies handed in
// by the caller (a queue item, slice 5), then the index by any copy's id (with failover to another
// host when the primary is offline), then a bare libraryId. Null -> fall back to the single active
// client (single-host mode, or a track not in the blend).
function routeTrack ({ trackId, libraryId, copies }) {
  const connected = connectedLibs()
  if (Array.isArray(copies) && copies.length) {
    const c = merge.bestCopy({ copies }, connected)
    return c ? { libraryId: c.libraryId, id: c.id } : null
  }
  const m = trackByAnyId.get(trackId)
  if (m) { const c = merge.bestCopy(m, connected); if (c) return { libraryId: c.libraryId, id: c.id } }
  if (libraryId) return { libraryId, id: trackId }
  return null
}

// Attach a track's merged COPIES (every host that has it, primary first) by dedup-key lookup in the
// index. A track fetched from one host only knows its own copy; the index knows the rest, which is
// what lets streaming (slice 4) fail over to another host. Falls back to the track's own single copy
// when the index has no match (e.g. a strict-Subsonic host whose flat track list was incomplete).
function enrichCopies (t) {
  if (mergedIndex) {
    const key = merge.trackKey(t)
    const m = mergedIndex.tracks.find((x) => x.key === key)
    if (m && Array.isArray(m.copies) && m.copies.length) return { ...t, libraryId: m.libraryId, copies: m.copies }
  }
  return { ...t, copies: [{ libraryId: t.libraryId, id: t.id, coverId: t.coverId }] }
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
    leaseOk: leaseValid,
    // Merged-mode streaming routing (step 2, slice 4). hostClient returns the connected pool client
    // for a URL that names its owning host; libForTrack/libForCover resolve a bare id to its host
    // for a URL that doesn't (the UI's own artBase covers). All three are inert in single-host mode
    // (no libraryId in the URL, resolvers return null), so that path is unchanged.
    hostClient: ensureHostById,
    libForTrack,
    libForCover
  })
  shimPort = await shim.listen()
  return shimPort
}

async function connectTo (host) {
  // Adopt this library BEFORE anything reads or writes per-host state (lease, outbox, queue).
  useLibrary(host.libraryId)
  // Pin the client we're dialing to a LOCAL ref. A library switch calls connectTo directly
  // while browse loaders can fire ensureConnected's single-flight reconnect in parallel (the
  // window where `connected` is briefly false) - two connect paths racing on the `client`
  // global. Whoever's dial the `client` global no longer points at has lost the race; it must
  // drop its connection instead of publishing a stale one (that race was reading `.conn` off a
  // client the winner had already nulled).
  const c = await ensureClient()
  await c.connect({ hostKey: host.hostKey, libraryId: host.libraryId })
  if (client !== c) { try { await c.close() } catch {} ; return }
  currentHost = host
  connected = true
  cancelReconnect() // back on: drop any pending retry and reset the backoff
  // A successful connect IS a fresh authorization - renew the offline lease.
  stampAuth()

  // Point the (already-listening) shim at the fresh client. Playback still flows
  // THROUGH the live connection for anything not cached, which is what makes a revoke
  // stop the music.
  await ensureShim()
  if (client !== c || !c.conn) { return } // swapped out (or torn down) during ensureShim

  shim.setClient(c)

  // The connection is gone: revoked, or the host went away, or - by far the most
  // common - Android suspended this app in the background and the link timed out.
  // Those are indistinguishable from here, so do NOT guess at the reason. Say what
  // happened and let whoever asks next reconnect. Ignore a close for a client we've
  // already been superseded by - its disconnect is not ours to report.
  c.conn.once('close', () => {
    if (client !== c) return
    connected = false
    log('host:disconnected')
    emit('host:disconnected', { hostKey: host.hostKey })
    // ...and then TRY TO GET IT BACK. Reconnection used to be purely on demand
    // (ensureConnected, when an RPC needs the host) plus the shell's app:active hook. That
    // leaves one hole, and it is the one people actually hit: a link that dies while the app
    // is in the FOREGROUND is never retried, because nothing asks. The idle heartbeat is sync
    // by design and never dials. So the library sits "Offline - unreachable" while the host is
    // up and reachable, until you background the app or restart it - measured at 11 hours on
    // one device, and seen on both platforms (2026-07-21).
    scheduleReconnect()
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
// --- automatic reconnect ----------------------------------------------------
//
// The backoff math is in worklet/retry.js (pure, unit-tested) because there are now TWO loops
// using it: this one for the active client, and the per-host pool loop below.
let retryTimer = null
let retryDelay = 0

function cancelReconnect () {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  retryDelay = 0
}

function scheduleReconnect () {
  if (retryTimer || (connected && client)) return
  if (!loadActiveHost()) return // unpaired: nothing to dial
  retryDelay = retry.nextDelay(retryDelay)
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (!loadActiveHost()) return cancelReconnect()
    if (connected && client) return cancelReconnect()
    ensureConnected().then(cancelReconnect, () => scheduleReconnect())
  }, retryDelay)
  // Never let a retry hold the worklet awake on its own account.
  if (retryTimer.unref) retryTimer.unref()
}

// --- automatic reconnect for POOL hosts (2026-07-21) ------------------------
//
// The same hole #121 closed for the active client, one level out. A pool link that dies had
// nothing that dialled it again: the only paths back were an explicit pull-to-refresh, an
// index rebuild, or a relaunch. So when a host in the blend restarts - which is exactly what
// deploying to it does - its half of the library goes dark and STAYS dark while the app runs,
// even though the host is reachable. Seen for real when the Umbrel was redeployed to 0.2.16:
// "Offline - unreachable" for minutes, instant recovery on relaunch.
//
// One timer per libraryId, same 5s->60s ladder, and every retry re-reads hosts.json - so a
// library removed while a retry is pending simply stops (the entry is gone), and a retry can
// never resurrect a host the user just dropped.
const poolRetry = new Map() // libraryId -> { timer, delay }

function cancelPoolReconnect (libraryId) {
  const r = poolRetry.get(libraryId)
  if (r && r.timer) clearTimeout(r.timer)
  poolRetry.delete(libraryId)
}

function cancelAllPoolReconnects () {
  for (const id of [...poolRetry.keys()]) cancelPoolReconnect(id)
}

function schedulePoolReconnect (host) {
  const libId = host && host.libraryId
  if (!libId) return
  // The pool exists to serve the BLEND. Outside merged mode the active-client loop above is
  // the one that matters, and dialling pool hosts nobody is reading is pure battery.
  if (!mergedMode()) return cancelPoolReconnect(libId)
  if (!loadHostsFile().hosts.some((h) => h.libraryId === libId)) return cancelPoolReconnect(libId)
  if (poolClient(libId)) return cancelPoolReconnect(libId)

  const r = poolRetry.get(libId) || { timer: null, delay: 0 }
  if (r.timer) return
  r.delay = retry.nextDelay(r.delay)
  r.timer = setTimeout(() => {
    r.timer = null
    const rec = loadHostsFile().hosts.find((h) => h.libraryId === libId)
    if (!rec || !mergedMode()) return cancelPoolReconnect(libId)
    if (poolClient(libId)) return cancelPoolReconnect(libId)
    ensureHost(rec).then(
      () => { cancelPoolReconnect(libId); onPoolHostBack(libId) },
      () => schedulePoolReconnect(rec)
    )
  }, r.delay)
  if (r.timer.unref) r.timer.unref()
  poolRetry.set(libId, r)
}

// A pool host answered again. Two different things have to happen, and only the first is free.
function onPoolHostBack (libraryId) {
  log('pool:reconnected', { library: String(libraryId).slice(0, 8) })
  // 1. The chip and the Settings row un-grey immediately - the connection is the fact they show.
  if (mergedMode()) emit('merged:updated', mergedStatusData())
  // 2. Its TRACKS are only back once the index is rebuilt. Rate-limiting exists to stop a host
  //    we cannot reach driving a rebuild loop; this one we just reached, and it is genuinely
  //    missing from the blend, so it has earned exactly one rebuild.
  if (!mergedConnected.has(libraryId)) rebuildIndex().catch(() => {})
}

async function ensureConnected () {
  if (connected && client) return

  const host = loadActiveHost()
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
    const f = loadHostsFile()
    const host = hostList.activeHost(f)
    const state = {
      deviceKey: b4a.toString(identity.publicKey, 'hex'),
      // The SAME encoding the host's dashboard prints in its device rows (grants
      // are keyed by z32). Settings shows this so an operator deciding which row
      // to revoke can match the phone in their hand to a line on the screen.
      deviceKeyZ32: z32.encode(identity.publicKey),
      host: host || null,
      // The full paired-library list (active flagged), so Settings can render the switcher
      // on launch without a second round-trip.
      hosts: f.hosts.map((h) => ({ ...h, active: h.hostKey === f.activeHostKey })),
      settings: loadSettings(),
      connected: false
    }

    // Deliver any leave that could not be sent when its library was removed (the host was
    // off at the time). Fire-and-forget: it dials hosts we no longer follow, so it must
    // never delay a cold launch or fail one.
    flushPendingLeaves().catch((e) => log('leaves:flush-failed', { err: e?.message }))

    if (host) {
      // Adopt the active library synchronously (paths + outbox) BEFORE the shim comes up or
      // any per-host state is read; the background connect below also calls this, idempotently.
      useLibrary(host.libraryId)
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
        scheduleReconnect() // the host may just be booting, or the wifi not up yet
      })

      // MERGED IS THE DEFAULT when 2+ libraries are paired (proposal 2026-07-19): flip merged mode
      // on, render the previous run's cached index INSTANTLY (loadCachedIndex is a sync disk read),
      // and rebuild from every host in the background (emits merged:updated when it lands). With 0-1
      // hosts there's nothing to blend, so the app stays single-host - byte-for-byte unchanged. The
      // single client above still connects (it backs the per-host "You" features + a streaming
      // fallback); merged mode only governs browse/streaming routing.
      if (f.hosts.length >= 2) {
        _mergedMode = true
        loadCachedIndex()
        state.merged = mergedStatusData()
        rebuildIndex().catch((e) => log('init:merged-rebuild-failed', { err: e.message }))
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

    // A BLANK name must never wipe the one this device already goes by. The add-a-library
    // flow prefills these fields, and a stale or empty prefill used to overwrite the real
    // name on disk - the phone would silently revert to an older identity just because you
    // added a second server.
    const claim = (userName || '').trim()
    saveSettings({ deviceName: name, ...(claim ? { userName: claim } : {}) })

    const host = {
      hostKey: paired.hostKey && paired.hostKey.length === 32
        ? require('z32').encode(paired.hostKey)
        : paired.hostKey,
      libraryId: paired.libraryId,
      libraryName: paired.libraryName
    }
    // Additive, not overwriting: a second pairing ADDS a library and makes it active (a
    // re-pair of a known host just refreshes + re-activates it, never duplicates the row).
    saveHostsFile(hostList.addHost(loadHostsFile(), host, Date.now()))

    // We are pairing this host, so CANCEL any leave still queued for it. Without this, a
    // removal that never reached an offline host would be retried after the user re-paired
    // and would revoke the grant they just created.
    const pending = loadLeaves()
    if (pending.some((e) => e.hostKey === host.hostKey)) {
      saveLeaves(leaves.dropLeave(pending, host.hostKey))
      log('leaves:cancelled-by-pair', { host: String(host.hostKey).slice(0, 8) })
    }

    await connectTo(host)

    // TELL THE HOST WHO WE SAY WE ARE. The pair handshake carries the device LABEL (hello.label)
    // but nothing about the person, so without this the name the user just typed under "Your name"
    // never leaves the phone: the operator sees an unclaimed row, the host cannot auto-create or
    // match a person, and the app sits on "Waiting for your server to confirm you are X" forever -
    // with no way out, because Settings only offers Save once the field is DIRTY. Best-effort by
    // design: a claim grants nothing (it is cosmetic until the operator confirms), so a host too
    // old to know identity.set, or a connection that drops here, must not fail a pair that has
    // already succeeded.
    if (claim) {
      try {
        await client.setIdentity({ deviceName: name, userName: claim })
      } catch (e) {
        log('pair:claim-failed', { err: e?.message })
      }
    }

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
  async tracks ({ cursor = 0, limit = 100, sort, order, libraryId } = {}) {
    if (mergedMode()) {
      const ix = await ensureIndex()
      // Default to A-Z by title: the merged index CAN sort all songs by title, which a single
      // Subsonic host can't (it has no all-songs sort). Items already carry libraryId + copies.
      const page = catalog.serveList(ix.tracks, { libraryId, sort: sort || 'title', order, cursor, limit })
      return { ...page, items: page.items.map(withArt) }
    }
    await ensureConnected()
    const page = await client.list({ type: 'tracks', cursor, limit, sort, order })
    return { ...page, items: page.items.map(withArt) }
  },

  // Album browsing is the primary way in. A flat list of 1358 tracks is not a
  // music app, and Subsonic has no "all songs" call anyway - so the flat list
  // could only ever show the first page. Albums page properly.
  async albums ({ cursor = 0, limit = 60, sort, order, libraryId } = {}) {
    if (mergedMode()) {
      const ix = await ensureIndex()
      const page = catalog.serveList(ix.albums, { libraryId, sort: sort || 'name', order, cursor, limit })
      return { ...page, items: page.items.map(withArt) }
    }
    await ensureConnected()
    const page = await client.list({ type: 'albums', cursor, limit, sort, order })
    return { ...page, items: page.items.map(withArt) }
  },

  // An album's track LIST isn't in the browse index, so in merged mode a detail read routes to the
  // album's owning host (authoritative order) via the pool, then tags the album + enriches each
  // track's copies so streaming can fail over. The UI passes the served album's libraryId back here.
  async album ({ id, libraryId }) {
    const lib = libForEntity(id, libraryId)
    if (mergedMode() && lib) {
      const c = await ensureHostById(lib)
      const a = await c.get({ id, type: 'album' })
      if (!a) return null
      return withBigArt({ ...a, libraryId: lib, tracks: (a.tracks || []).map((t) => enrichCopies({ ...t, libraryId: lib })) })
    }
    await ensureConnected()
    const a = await client.get({ id, type: 'album' })
    return a ? withBigArt(a) : null
  },

  // Artists are the second way in. The host has always been able to list them
  // (`library.list({type:'artists'})`); nothing was asking.
  async artists ({ sort, order, libraryId } = {}) {
    if (mergedMode()) {
      const ix = await ensureIndex()
      const page = catalog.serveList(ix.artists, { libraryId, sort: sort || 'name', order })
      return { ...page, items: page.items.map(withArt) }
    }
    await ensureConnected()
    const page = await client.list({ type: 'artists', sort, order })
    return { ...page, items: page.items.map(withArt) }
  },

  // An artist page is a grid of that artist's albums, so its albums need art too. In merged mode the
  // detail routes to the artist's owning host (its full album list); each album carries libraryId so
  // tapping through routes correctly. (A blended cross-host artist page - one host's albums beside
  // another's for the same artist - is a later refinement; phase 1 shows the primary host's.)
  async artist ({ id, libraryId }) {
    const lib = libForEntity(id, libraryId)
    if (mergedMode() && lib) {
      // BLEND across hosts: the same artist can live on more than one host, so fetch each copy's
      // artist page and merge their albums (deduped by album key, like the browse index). One host's
      // "OK Computer" beside another's shows once; a rip only one host has still appears.
      const m = mergedIndex && mergedIndex.artists.find((x) => x.id === id || (x.copies || []).some((cp) => cp.id === id))
      const copies = (m && Array.isArray(m.copies) && m.copies.length) ? m.copies : [{ libraryId: lib, id }]
      const settled = await Promise.allSettled(copies.map(async (cp) => {
        const c = await ensureHostById(cp.libraryId)
        const a = await c.get({ id: cp.id, type: 'artist' })
        return a ? { a, libraryId: cp.libraryId } : null
      }))
      const parts = settled.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value)
      if (!parts.length) return null
      const primary = parts.find((p) => p.libraryId === lib) || parts[0]
      // Tag each host's albums with its libraryId, then dedupe across hosts (mergeAlbums keeps copies
      // + picks the most-complete as primary), so tapping through routes correctly.
      const allAlbums = parts.flatMap((p) => (p.a.albums || []).map((al) => ({ ...al, libraryId: p.libraryId })))
      const albums = merge.mergeAlbums(allAlbums)
      // Album-less (composite-tag) artists carry loose tracks instead; blend + dedupe those too.
      const allTracks = parts.flatMap((p) => (p.a.tracks || []).map((t) => ({ ...t, libraryId: p.libraryId })))
      const tracks = albums.length ? [] : merge.mergeTracks(allTracks)
      return {
        ...withBigArt({ ...primary.a, libraryId: lib }),
        albums: albums.map(withArt),
        tracks: tracks.map(withArt)
      }
    }
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
  async artistTracks ({ id, libraryId }) {
    // In merged mode read from the artist's owning host (its albums live there); otherwise the
    // single active client. Either way each track is tagged with its libraryId + copies so a
    // mixed-host queue (slice 4) routes every track to a host that has it.
    const lib = libForEntity(id, libraryId)
    let c
    if (mergedMode() && lib) c = await ensureHostById(lib)
    else { await ensureConnected(); c = client }
    const tag = (t) => (mergedMode() ? enrichCopies({ ...t, libraryId: lib }) : t)

    const a = await c.get({ id, type: 'artist' })
    if (!a) return { items: [] }

    // An artist with no albums still has songs (see the host adapter). Play those
    // rather than reporting an empty artist, which is what "nothing to play there"
    // used to mean.
    if (!(a.albums || []).length) return { items: (a.tracks || []).map((t) => withArt(tag(t))) }

    const items = []
    for (const al of a.albums || []) {
      const full = await c.get({ id: al.id, type: 'album' })
      if (!full) continue
      const art = full.coverId && shim ? shim.artUrlFor(full.coverId) : null
      const artFull = full.coverId && shim ? shim.artUrlFor(full.coverId, 1200) : null
      for (const t of full.tracks || []) items.push({ ...tag(t), art, artFull })
    }
    return { items }
  },

  // Genres are the BROADEST way in - list them, then a genre page is a grid of its
  // albums. Same wire methods as artists (library.list / library.get with a new
  // `genres` / `genre` type); the host does the work, this just adds artwork.
  async genres ({ sort, order, libraryId } = {}) {
    if (mergedMode()) {
      const ix = await ensureIndex()
      const page = catalog.serveList(ix.genres, { libraryId, sort: sort || 'name', order })
      return { ...page, items: page.items.map(withArt) }
    }
    await ensureConnected()
    const page = await client.list({ type: 'genres', sort, order })
    return { ...page, items: page.items.map(withArt) }
  },

  // A genre page is a grid of its albums (tracks only for a loose-tagged genre with
  // no album of its own - the same fallback artists use). In merged mode the detail routes to the
  // genre's owning host; its albums carry libraryId so tapping through routes correctly.
  async genre ({ id, libraryId }) {
    const lib = libForEntity(id, libraryId)
    let c
    if (mergedMode() && lib) c = await ensureHostById(lib)
    else { await ensureConnected(); c = client }
    const g = await c.get({ id, type: 'genre' })
    if (!g) return null
    const tagAlbum = (al) => (mergedMode() ? { ...al, libraryId: lib } : al)
    const tagTrack = (t) => (mergedMode() ? enrichCopies({ ...t, libraryId: lib }) : t)
    return {
      ...withBigArt(mergedMode() ? { ...g, libraryId: lib } : g),
      albums: (g.albums || []).map((al) => withArt(tagAlbum(al))),
      tracks: (g.tracks || []).map((t) => withArt(tagTrack(t)))
    }
  },

  // Every track in a genre, in album order - what "Play" on a genre means. Mirrors
  // artistTracks: one round trip per album, plus the loose-track fallback.
  async genreTracks ({ id, libraryId }) {
    const lib = libForEntity(id, libraryId)
    let c
    if (mergedMode() && lib) c = await ensureHostById(lib)
    else { await ensureConnected(); c = client }
    const tag = (t) => (mergedMode() ? enrichCopies({ ...t, libraryId: lib }) : t)

    const g = await c.get({ id, type: 'genre' })
    if (!g) return { items: [] }
    if (!(g.albums || []).length) return { items: (g.tracks || []).map((t) => withArt(tag(t))) }

    const items = []
    for (const al of g.albums || []) {
      const full = await c.get({ id: al.id, type: 'album' })
      if (!full) continue
      const art = full.coverId && shim ? shim.artUrlFor(full.coverId) : null
      const artFull = full.coverId && shim ? shim.artUrlFor(full.coverId, 1200) : null
      for (const t of full.tracks || []) items.push({ ...tag(t), art, artFull })
    }
    return { items }
  },

  // The merged "Recently added" shelf. Every adapter now tags albums with a real `addedAt` (folder
  // mtime, Subsonic `created`, Jellyfin DateCreated), and buildIndex keeps the NEWEST across copies -
  // so this is a TRUE global date-sort across the blend (newest first), not a per-host interleave.
  async recentMerged ({ limit = 12 } = {}) {
    if (!mergedMode()) return { items: [] }
    const ix = await ensureIndex()
    const page = catalog.serveList(ix.albums, { sort: 'added', order: 'desc', cursor: 0, limit })
    return { items: page.items.map(withArt) }
  },

  async search ({ q, libraryId } = {}) {
    if (mergedMode()) {
      const ix = await ensureIndex()
      const r = catalog.searchIndex(ix, q)
      const filt = (arr) => merge.filterByLibrary(arr, libraryId)
      // Merged search hits everything and returns TRACKS too (each deduped, copy-tagged) - a single
      // host's search couldn't sort/merge songs across hosts.
      return {
        tracks: filt(r.tracks).map(withArt),
        albums: filt(r.albums).map(withArt),
        artists: filt(r.artists).map(withArt)
      }
    }
    await ensureConnected()
    const r = await client.search({ q })
    return {
      ...r,
      albums: (r.albums || []).map(withArt),
      artists: (r.artists || []).map(withArt)
    }
  },

  // --- merged library (step 2, proposal 2026-07-19) ---------------------------
  //
  // Enter the blended view: flip merged mode on (browse/streaming now serve from the index), show
  // the last run's cached index instantly, then rebuild from every connected host. Idempotent - a
  // repeat call just refreshes. The merged-default UI (slice 5) calls this on launch when 2+ hosts
  // are paired; the '_all' filter chip also calls it to return from a single-host focus.
  async enterMerged () {
    _mergedMode = true
    loadCachedIndex() // render instantly from the previous run while the live rebuild runs
    await ensureShim() // browse maps art through the shim; it's up already on a normal launch
    await rebuildIndex()
    return mergedStatusData()
  },

  // Leave the blended view for a single library (the Settings switcher's "focus one host"). The
  // merged index stays cached; re-entering is instant. switchHost does this too.
  exitMerged () {
    _mergedMode = false
    // Nobody is reading the blend now, so stop dialling for it. Re-entering merged mode
    // reconnects on demand (ensureAll), and a link that dies after that schedules afresh.
    cancelAllPoolReconnects()
    return { merged: false }
  },

  // Rebuild the index (a host reconnected, or a pull-to-refresh). Only meaningful in merged mode.
  // An auto-trigger (a reconnect) is rate-limited so a permanently-unreachable host can't drive a
  // rebuild loop; an explicit pull-to-refresh passes force to rebuild now regardless.
  async refreshMerged ({ force = false } = {}) {
    if (!mergedMode()) return { merged: false }
    if (!force && mergedIndex && (Date.now() - lastIndexBuiltAt) < REBUILD_COOLDOWN_MS) return mergedStatusData()
    await rebuildIndex()
    return mergedStatusData()
  },

  // Per-library status for the source-filter chips + greying: every paired library, whether it's in
  // the current index (connected at build time), and how many of its tracks are in the blend. The
  // '_all' chip (the whole blend) is implicit and the default.
  mergedStatus () { return mergedStatusData() },

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
    // Live library-name update: the operator can rename the library on the dashboard, and identity.get
    // carries the CURRENT name. If it changed, persist it to the host record and tell the UI, so the
    // header + switcher + merged chips update without a re-pair.
    if (remote?.libraryName) {
      const active = loadActiveHost()
      if (active && active.libraryName !== remote.libraryName) {
        saveHostsFile(hostList.renameHost(loadHostsFile(), active.hostKey, remote.libraryName))
        emit('host:renamed', { hostKey: active.hostKey, libraryName: remote.libraryName })
      }
    }
    // Extend that live rename to the OTHER hosts in a blend. This method rides loadIdentity(), which
    // fires on EVERY host:connected - but a complete-blend reconnect reloads browse WITHOUT a rebuild,
    // so syncHostNames (which only rides rebuildIndex) never runs and a non-active host's rename stays
    // stale in the chip. Sync the connected pool hosts here too, on the same trigger the active host
    // uses. Fire-and-forget so identity() stays fast; syncHostNames emits host:renamed per change.
    if (mergedMode()) {
      const activeKey = loadActiveHost()?.hostKey
      const others = loadHostsFile().hosts.filter((h) => h.hostKey !== activeKey && poolClient(h.libraryId))
      if (others.length) syncHostNames(others).catch(() => {})
    }
    return {
      deviceName: remote?.deviceName || local.deviceName || '',
      userName: remote?.user?.name || local.userName || '',
      confirmed: !!remote?.user?.confirmed,
      belongsTo: remote?.belongsTo || null,
      libraryName: remote?.libraryName || null,
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

  // Set (or clear) this device's avatar - `avatar` is base64 JPEG bytes (the UI
  // resizes to ~200px first), or empty to remove it. Saved locally so the profile
  // header shows it even offline, and pushed to the host (shown on its dashboard).
  async setAvatar ({ avatar }) {
    const a = avatar || ''
    saveSettings({ avatar: a })
    try { await ensureConnected(); await client.setAvatar({ avatar: a }) } catch {}
    return { ok: true, avatar: a }
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
      fs.mkdirSync(libDir(), { recursive: true })
      fs.writeFileSync(queueFile(), JSON.stringify(snapshot || {}))
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
    // The session target is the elected home host in merged mode (carrying the mixed-host queue),
    // else the single active client. SYNC lookup - a heartbeat never dials; if the home is offline
    // we keep the token and retry on the next snapshot, exactly as single mode does when offline.
    const tgt = sessionActive ? sessionTarget() : null
    if (tgt && tgt.c && sessionSupportedFor(tgt.lib) && snapshot) {
      const items = Array.isArray(snapshot.items) ? snapshot.items : []
      try {
        const queue = items.map(t => tagSessionItem(
          { trackId: t.id, title: t.title, artist: t.artist, album: t.album, art: t.art, artFull: t.artFull, durationMs: t.durationMs },
          t.id, tgt.merged))
        // positionMs + playing ride this same heartbeat, so "Play here" seeks to the exact
        // spot from the claim reply (no separate resume round-trip) and another device's card
        // can say "Paused on <name>" honestly. The shell forces a snapshot on pause, so the
        // paused state + exact position land at once rather than up to a heartbeat late.
        const r = await tgt.c.sessionSet({ queue, index: snapshot.index || 0, shuffle: !!snapshot.shuffle, repeat: Number(snapshot.repeat) || 0, positionMs: Number(snapshot.positionMs) || 0, playing: !!snapshot.playing, merged: tgt.merged })
        if (r && r.ok === false) { sessionActive = false; lostSession = true } // superseded
      } catch (e) {
        if (e?.code === 'ENOMETHOD') markSessionUnsupported(tgt.lib)
        // offline / transient: keep the token, retry on the next snapshot
      }
    }
    return { ok: true, lostSession }
  },
  async loadQueueState () {
    try {
      return JSON.parse(fs.readFileSync(queueFile(), 'utf8'))
    } catch {
      return null
    }
  },
  async clearQueueState () {
    try { fs.unlinkSync(queueFile()) } catch {}
    return { ok: true }
  },

  // --- cross-device session handoff (proposal 2026-07-17) ---------------------
  //
  // Become the active player. Called by the shell when playback starts here. Idempotent: a no-op
  // if we already hold the token. Otherwise read the current generation and CAS-claim it (one
  // retry if another device claimed in the same instant). Claiming ADOPTS the existing queue on
  // the host; the shell's next saveQueueState overwrites it with ours.
  async sessionActivate () {
    if (sessionActive) return { active: true }
    let lib = null
    try {
      const { c, merged, lib: l } = await sessionReady()
      lib = l
      if (!c) return { active: false } // offline; the next play retries
      if (!sessionSupportedFor(lib)) return { active: false, supported: false } // this host is old
      for (let i = 0; i < 2; i++) {
        const cur = await c.sessionGet(merged ? { merged: true } : undefined)
        const r = await c.sessionClaim({ generation: cur?.generation || 0, merged })
        if (r?.ok) { sessionActive = true; sessionGen = r.session.generation; return { active: true } }
      }
      return { active: false }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') { markSessionUnsupported(lib); return { active: false, supported: false } }
      return { active: false } // offline; the next play retries
    }
  },

  // Stop being the active player (the shell's stop). Does NOT release the host token - the
  // session persists as last-known so another device can still "Play here"; we just stop pushing.
  sessionDeactivate () { sessionActive = false; return { ok: true } },

  // What the UI needs for the "Playing on <name>" card: is another of my devices actively
  // holding a non-empty session. Tracks the generation for a later claim.
  async sessionInfo () {
    let lib = null
    try {
      const { c, merged, lib: l } = await sessionReady()
      lib = l
      if (!c) return { supported: true, offline: true }
      if (!sessionSupportedFor(lib)) return { supported: false } // this host is old
      const s = await c.sessionGet(merged ? { merged: true } : undefined)
      if (s) sessionGen = s.generation
      return {
        supported: true,
        active: !!(s && s.isActiveHere), // is THIS device the active one
        hasQueue: !!(s && Array.isArray(s.queue) && s.queue.length > 0),
        activeDeviceName: s?.activeDeviceName || null,
        activePlaying: !!(s && s.playing), // is the active device PLAYING or paused (card wording)
        count: s?.queue?.length || 0
      }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') { markSessionUnsupported(lib); return { supported: false } }
      return { supported: true, offline: true }
    }
  },

  // "Play here": claim the token and hand the session queue back to the shell (mapped to its
  // shape) plus the current track's resume position, so the shell rebuilds + seeks + plays.
  async sessionTakeover () {
    let lib = null
    try {
      const { c, merged, lib: l } = await sessionReady()
      lib = l
      if (!c) return { ok: false }
      if (!sessionSupportedFor(lib)) return { ok: false, supported: false } // this host is old
      for (let i = 0; i < 2; i++) {
        const s = await c.sessionGet(merged ? { merged: true } : undefined)
        if (!s || !Array.isArray(s.queue) || !s.queue.length) return { ok: false, empty: true }
        const r = await c.sessionClaim({ generation: s.generation, merged })
        if (r?.ok) {
          sessionActive = true; sessionGen = r.session.generation
          const items = r.session.queue.map(t => ({ id: t.trackId, title: t.title, artist: t.artist, album: t.album, art: t.art, artFull: t.artFull, durationMs: t.durationMs }))
          const cur = items[r.session.index || 0]
          // Seek to the position the leaving device pushed with the queue (exact when it paused
          // first, <=one heartbeat old otherwise). Fall back to the per-track resume row only if
          // the session carries none (an old host, or a session written before this shipped). In
          // merged mode the fallback resume lives on the track's OWNING host, not the home host.
          let positionMs = Number(r.session.positionMs) || 0
          if (!positionMs && cur) {
            const rc = merged ? (poolClient(trackLib.get(cur.id)) || c) : c
            try { const rp = await rc.resumeGet({ trackId: cur.id }); positionMs = rp?.positionMs || 0 } catch {}
          }
          return { ok: true, items, index: r.session.index || 0, shuffle: !!r.session.shuffle, repeat: r.session.repeat || 0, positionMs }
        }
      }
      return { ok: false }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') { markSessionUnsupported(lib); return { ok: false, supported: false } }
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
    if (mergedMode()) {
      // The blended hearts: the UNION of every connected host's favorites, cached at lib/_merged.
      try {
        const { ok, grouped } = await unionFavs()
        if (ok) { saveMergedFavCache(grouped); return { ...grouped, supported: true } }
        return { ...loadMergedFavCache(), supported: true, offline: true }
      } catch {
        return { ...loadMergedFavCache(), supported: true, offline: true }
      }
    }
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
    if (mergedMode()) {
      // Route the resume to the track's OWNING host; queue to that host's outbox if it's unreachable,
      // so it syncs when the host reconnects (coalesce keeps only the latest position per track).
      const lib = favHost('track', trackId)
      const c = lib && poolClient(lib)
      if (c) { try { await c.resumeSet({ trackId, positionMs, durationMs }) } catch { enqueueFor(lib, 'resume.set', { trackId, positionMs, durationMs }) } }
      else if (lib) enqueueFor(lib, 'resume.set', { trackId, positionMs, durationMs })
      return { ok: true }
    }
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
    if (mergedMode()) {
      const c = trackClient(trackId)
      if (c) { try { return await c.resumeGet({ trackId }) } catch {} }
      return { positionMs: 0 }
    }
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
    if (mergedMode()) {
      // The globally-most-recent resume across hosts: each host's latest, then pick the newest by
      // updatedAt, and resolve the track from that host.
      const libs = [...connectedLibs()]
      const settled = await Promise.allSettled(libs.map(async (lib) => {
        const c = poolClient(lib)
        if (!c) return null
        const r = await c.resumeLatest()
        return r && r.trackId ? { ...r, lib } : null
      }))
      const cands = settled.filter((x) => x.status === 'fulfilled' && x.value).map((x) => x.value)
      if (!cands.length) return null
      cands.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      const best = cands[0]
      const c = poolClient(best.lib)
      const t = c && await c.get({ id: best.trackId, type: 'track' }).catch(() => null)
      if (!t) return null
      return { track: withArt({ ...t, libraryId: best.lib }), positionMs: best.positionMs, durationMs: best.durationMs }
    }
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
    if (mergedMode()) {
      // Count the play on the track's OWNING host; queue to that host's outbox if unreachable, so the
      // play isn't lost (each queued bump is a real play - counts accumulate).
      const lib = favHost('track', trackId)
      const c = lib && poolClient(lib)
      if (c) { try { await c.countBump({ trackId }) } catch { enqueueFor(lib, 'count.bump', { trackId }) } }
      else if (lib) enqueueFor(lib, 'count.bump', { trackId })
      return { ok: true }
    }
    if (connected && client) {
      try { await client.countBump({ trackId }) } catch { enqueue('count.bump', { trackId }) }
    } else {
      // Offline: queue it (counts accumulate - each queued bump is a real play).
      enqueue('count.bump', { trackId })
    }
    return { ok: true }
  },

  async topPlayed ({ limit = 50 } = {}) {
    if (mergedMode()) {
      // Merge each host's most-played. The SAME track on two hosts has different ids, so group by the
      // merged track's dedup key and SUM counts (a play on either host is a play), then resolve the
      // top N from a host that has them.
      const libs = [...connectedLibs()]
      const settled = await Promise.allSettled(libs.map(async (lib) => {
        const c = poolClient(lib)
        if (!c) return []
        const r = await c.countTop({ limit: limit * 2 })
        return (r.items || []).map((it) => ({ ...it, lib }))
      }))
      const raw = settled.filter((x) => x.status === 'fulfilled').flatMap((x) => x.value)
      const byKey = new Map()
      for (const it of raw) {
        const m = trackByAnyId.get(it.trackId)
        const key = m ? m.key : it.trackId
        const g = byKey.get(key)
        if (g) g.count += (Number(it.count) || 0)
        else byKey.set(key, { trackId: it.trackId, lib: it.lib, count: Number(it.count) || 0 })
      }
      const top = [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, limit)
      const out = []
      for (const it of top) {
        const c = poolClient(it.lib)
        if (!c) continue
        const t = await c.get({ id: it.trackId, type: 'track' }).catch(() => null)
        if (t) out.push({ ...withArt({ ...t, libraryId: it.lib }), playCount: it.count })
      }
      return { items: out }
    }
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
    if (mergedMode()) {
      // Route to the host that OWNS this item; flip the blended cache optimistically so the heart
      // reacts instantly. If the owning host is unreachable, queue the write to its outbox so it syncs
      // on reconnect (LWW - coalesce keeps only the latest on/off per item).
      applyMergedFav(kind, id, want)
      const lib = favHost(kind, id)
      const c = lib && poolClient(lib)
      if (c) {
        try {
          const r = await c.favSet({ kind, id, on: want })
          return { kind: r.kind, id: r.id, on: r.on }
        } catch (e) {
          if (e?.code === 'ENOMETHOD') { applyMergedFav(kind, id, !want); throw e }
          enqueueFor(lib, 'fav.set', { kind, id, on: want })
          return { kind, id, on: want, queued: true }
        }
      }
      if (lib) enqueueFor(lib, 'fav.set', { kind, id, on: want })
      return { kind, id, on: want, queued: true }
    }
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
    if (mergedMode()) {
      // Union across hosts, then resolve each favorite from the SAME host that has it (src map), so a
      // track favorited on the Mac resolves off the Mac. Skips anything unresolvable, like single-host.
      const { grouped, src } = await unionFavs()
      saveMergedFavCache(grouped)
      const resolve = async (ids, type) => {
        const out = []
        for (const id of ids) {
          const lib = src.get(id)
          const c = lib && poolClient(lib)
          if (!c) continue
          const it = await c.get({ id, type }).catch(() => null)
          if (it) out.push(withArt({ ...it, libraryId: lib }))
        }
        return out
      }
      return {
        tracks: await resolve(grouped.track, 'track'),
        albums: await resolve(grouped.album, 'album'),
        artists: await resolve(grouped.artist, 'artist')
      }
    }
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
  async urlFor ({ trackId, libraryId, copies }) {
    await ensureShim()
    // Merged mode: route to the track's best CONNECTED copy and mint a libraryId-scoped URL, so the
    // player's held URL routes to the owning host for the life of the queue (proposal §5). A cached
    // track with a fresh lease plays from disk host-agnostically (ids are namespaced); otherwise
    // revive that specific host. copies/libraryId ride from the queue item when the shell provides
    // them (slice 5); until then the index lookup resolves it.
    if (mergedMode()) {
      const route = routeTrack({ trackId, libraryId, copies })
      if (route) {
        if (!(audioCache.has(route.id) && leaseValid())) { try { await ensureHostById(route.libraryId) } catch {} }
        return { url: shim.urlForLib(route.libraryId, route.id), port: shimPort }
      }
    }
    // Single-host: a cached track with a fresh lease plays from disk with no connection; anything
    // else (uncached, or an expired lease) needs the live stream, so revive the link - which
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
          // Tagged with the library, same as the shim's write-through: it is what lets
          // removing ONE library reclaim its bytes while the others stay downloaded.
          const sink = audioCache.createSink(t.id, { mime, size: t.size, library: client.libraryId || currentHost?.libraryId || null })
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

  // The paired libraries, the active one flagged - Settings renders the switcher from this.
  listHosts () { return listHostsData() },

  // Switch the active library. Tear down the current connection and dial the new host; the
  // shim (and its stable loopback port) SURVIVES, and a track already streaming keeps playing
  // from the shared, content-addressed audio cache - a switch swaps the queue but does not
  // stop the music (proposal 2026-07-19; the same decoupling graceful-reconnect relies on).
  // The shell reloads the new library's saved queue when it hears host:switched.
  async switchHost ({ hostKey }) {
    const f = hostList.setActive(loadHostsFile(), hostKey) // throws if not paired with it
    saveHostsFile(f)
    const host = hostList.activeHost(f)
    _mergedMode = false // focusing one library leaves the blended view (the '_all' chip re-enters it)
    cancelAllPoolReconnects() // same reason as exitMerged: no blend, no pool dialling
    if (client) { try { await client.close() } catch {} ; client = null }
    connected = false
    useLibrary(host.libraryId)
    // Dial the new host now, but do NOT let a transient failure abort the switch: tearing the
    // old link down and immediately dialing can lose a race with the teardown (a one-off
    // "host refused"). The active library is ALREADY switched (activeHostKey persisted), so on
    // a failed first dial we just let the next request's ensureConnected reconnect and fire
    // host:connected - exactly the app's normal offline-tolerant path. Either way we emit
    // host:switched so the UI swaps and the new library's queue is offered.
    try {
      await connectTo(host)
    } catch (e) {
      log('switch:connect-deferred', { err: e.message })
      scheduleReconnect()
    }
    emit('host:switched', { hostKey: host.hostKey, libraryId: host.libraryId, libraryName: host.libraryName, shimPort })
    return { ...host, shimPort }
  },

  // Remove ONE library (per-host unpair). Purges just that library's local state and its
  // downloaded audio; the device identity and every OTHER library are untouched - so re-adding
  // it later reuses the same grant row rather than littering the operator's dashboard. If it
  // was the active library, retarget to whatever remains (or fall back to the un-paired state
  // when it was the last one). Full "forget everything" stays a separate reset (forget()).
  async removeHost ({ hostKey }) {
    const before = loadHostsFile()
    // Tell the host we're leaving (best-effort, while the connection is still up) so it drops our
    // own grant, before we tear the connection down below (proposal 2026-07-20).
    const leaving = before.hosts.find((h) => h.hostKey === hostKey)
    // If the host was unreachable it never heard this, so REMEMBER it and retry on a later
    // launch. Otherwise the phone forgets the library while the host keeps a live grant -
    // the same action leaving two different host states (found 2026-07-21).
    if (leaving && !(await leaveHostBestEffort(leaving.libraryId))) {
      saveLeaves(leaves.queueLeave(loadLeaves(), leaving))
      log('leaves:queued', { host: hostKey.slice(0, 8) })
    }
    const wasActive = before.activeHostKey === hostKey
    const { file, removed } = hostList.removeHost(before, hostKey)
    saveHostsFile(file)
    if (removed) {
      purgeLibrary(removed.libraryId)
      // Stop dialling it BEFORE closing, or the close handler schedules a retry for the very
      // library we are removing. (The retry re-reads hosts.json and would stop on its own, but
      // a removal should not leave a doomed timer running for up to a minute either.)
      cancelPoolReconnect(removed.libraryId)
      const pe = pool.get(removed.libraryId) // drop any merged-mode connection to it
      if (pe) { try { if (pe.client) pe.client.close() } catch {} ; pool.delete(removed.libraryId) }
      mergedIndex = null // a removed host must leave the blend; next merged browse rebuilds
      mergedConnected.delete(removed.libraryId)
      buildRouteMaps() // clears the routing lookups until the rebuild
    }

    // Merged is only a thing with 2+ libraries. Dropping to one (or none) leaves the blended view
    // for the single-host experience - matching the host:switched the UI hears below, which flips
    // its own merged flag off. (Removing one of THREE keeps merged, so guard on the new count.)
    if (file.hosts.length < 2) {
      _mergedMode = false
      // The blend is over, so its cached state describes libraries this device may no longer
      // follow. It is all derived (the next rebuild refetches it), so drop it rather than leave
      // a stale favorites/queue/index for a removed library sitting on disk.
      purgeMerged()
    }

    // THE LAST LIBRARY IS GONE, so nothing on this device has anything left to play. Clear the
    // shared blob caches, which removeHost otherwise never touches: purgeLibrary only drops the
    // audio of that library's PINNED downloads, so the streamed LRU cache used to survive
    // removing every library (97 MB of it, measured 2026-07-21) with no way left to reclaim it
    // now that "Unpair all" is gone from the UI. Ids are hashed per library and cannot be
    // attributed back to one, so a precise per-library purge needs the cache index to record
    // the library - logged as a follow-up; this closes the case that actually strands bytes.
    if (!file.hosts.length) {
      try { audioCache.clear() } catch {}
      try { artStore.clear() } catch {}
      log('local:blobs-purged')
    }

    if (wasActive) {
      if (client) { try { await client.close() } catch {} ; client = null }
      connected = false
      const next = hostList.activeHost(file)
      if (next) {
        useLibrary(next.libraryId)
        // Reconnect in the background so the RPC returns promptly; the shell swaps to the new
        // library on host:switched and reloads its queue.
        connectTo(next).catch((e) => {
          log('remove:reconnect-failed', { err: e.message })
          emit('host:disconnected', { hostKey: next.hostKey })
          scheduleReconnect()
        })
        emit('host:switched', { hostKey: next.hostKey, libraryId: next.libraryId, libraryName: next.libraryName, shimPort })
      } else {
        // No libraries left: back to un-paired. The shim keeps listening (its port is stable
        // and harmless); the shell shows the pairing wall.
        activeLibraryId = null
        cancelReconnect() // no libraries left: stop dialling
        emit('host:disconnected', { hostKey })
      }
    }

    return listHostsData()
  },

  // Unpair EVERYTHING (full account reset). Forgets every paired library and drops the
  // connection.
  //
  // Note what this does NOT do: it does not touch the device identity. The keypair stays, so
  // re-pairing reuses the same device identity. We DO tell each currently-connected host we're
  // leaving (best-effort self-leave, proposal 2026-07-20) so it drops our grant - a re-pair then
  // reuses the same row, but as a fresh (re-confirmable) grant rather than silently live. Offline
  // hosts get nothing (they can't be reached); the operator can still delete those rows. (To drop
  // a SINGLE library, use removeHost.)
  async forget () {
    // Grab the list BEFORE we drop it, so every per-host dir gets purged too.
    const all = loadHostsFile().hosts
    // Best-effort self-leave to every connected host, while the connections are still up.
    // Whatever could not be delivered is queued and retried later, same as removeHost.
    const delivered = await Promise.all(all.map((h) => leaveHostBestEffort(h.libraryId)))
    let queued = loadLeaves()
    all.forEach((h, i) => { if (!delivered[i]) queued = leaves.queueLeave(queued, h) })
    saveLeaves(queued)
    try {
      fs.unlinkSync(HOSTS_FILE)
    } catch {}

    // Unpair is a deliberate goodbye: wipe every local copy (downloads, cached state,
    // the lease) across all libraries. The reliable purge point a reconnect failure never is.
    purgeAllLibraries(all.map((h) => h.libraryId))
    activeLibraryId = null
    cancelReconnect()

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
    await closePool() // tear down every merged-mode pool connection too
    mergedIndex = null // drop the blended index and its cache-in-memory
    mergedConnected = new Set()
    buildRouteMaps() // clears the routing lookups
    // A full reset tears the shared dht node down too (a later pair recreates it). Client
    // close() leaves it alone by design, so destroy it here or it would leak past a forget.
    if (dht) { try { await dht.destroy() } catch {} ; dht = null }
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
