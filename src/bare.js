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
const Hyperswarm = require('hyperswarm')
// Internal NAT sampler, used best-effort by the diagnostics to classify THIS phone's
// NAT (open / consistent / random). Deep-path require, so it is wrapped in try/catch at
// the call site - if hyperdht moves it, the diagnostic just omits the classification.
const { PearTuneClient } = require('../client')
const { createAudioShim, mimeFor, DEFAULT_ART_SIZE } = require('../worklet/shim')
const { streamParams } = require('../worklet/quality')
const { isPairLink, parseLink } = require('../protocol/link')
const { hostTopic, libraryId: deriveLibraryId } = require('../protocol/ids')
const { RELAY_PUBLIC_KEY, relayThroughFor, relayAudioDecision } = require('../protocol/relay')
const hostList = require('../worklet/hosts')
const { linkActions, stuckDialAction, WATCHDOG_MS, PING_TIMEOUT_MS } = require('../worklet/link-health')
const { createRebuildGate } = require('../worklet/rebuild-gate')
const { pickAltCopy } = require('../worklet/failover')
const merge = require('../worklet/merge')
const catalog = require('../worklet/catalog')
const { coalesce, clientCall } = require('../worklet/outbox')
const leaves = require('../worklet/leaves')
const session = require('../worklet/session')
const { sessionVerdict } = session
const { AudioCache } = require('../worklet/cache')
const { ArtStore } = require('../worklet/art-cache')
const demo = require('../worklet/demo')

const DATA_DIR = Bare.argv[0] || '/tmp/peartune'
// A RELATIVE data dir is always a bug in the caller, never a choice. It resolves against
// whatever the worklet's cwd happens to be, so the app silently runs on a phantom directory
// with no identity and no hosts while the real ones sit untouched somewhere else - a paired
// phone showing onboarding. The shell now refuses to pass one (app/index.tsx); this is the
// second line of that fence, because the failure is invisible without it.
if (!path.isAbsolute(DATA_DIR)) {
  throw new Error(`data dir must be absolute, got ${JSON.stringify(DATA_DIR)}`)
}
// What kind of device this is, handed down by the shell (argv[1]) because only the shell knows.
// It rides the pairing claim so an operator's dashboard names the device type correctly - this was
// hardcoded to 'android' until the first signed iOS build showed every iPhone arriving as an
// Android phone (2026-07-28). Defaults to android for an old shell that passes nothing, which
// keeps existing Android devices reading exactly as before.
const PLATFORM = Bare.argv[1] || 'android'
// The name a device goes by when the person did not choose one. "Android phone" on an iPhone is
// the same lie in friendlier clothing, so it follows the platform too.
const DEFAULT_DEVICE_NAME = PLATFORM === 'ios' ? 'iPhone' : 'Android phone'
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
// The DEFAULT library (P3, proposal 2026-07-26). Not a connection tier - every paired library is
// connected the same way (see `links`). This answers "which library did the caller mean when it
// named none", and it is the one single-host mode shows. Persisted as hosts.json activeHostKey,
// whose name is kept so no migration is needed.
let defaultLibraryId = null
function libDir () {
  if (!defaultLibraryId) throw new Error('No default library.')
  return path.join(LIB_ROOT, defaultLibraryId)
}

// The MERGED view (multi-host step 2, proposal 2026-07-19): when on, browse/search/streaming serve
// from the in-memory merged INDEX (every connected host's catalog, deduped) instead of a single
// host's client. It is a MODE FLAG, deliberately DECOUPLED from defaultLibraryId: that pointer
// still names the library a caller means when it names none (so the "You" features - favorites,
// resume, counts, session - have a home in merged mode, the proposal's "per-filter for now"),
// while mergedMode governs the blended browse. Tying merged mode to defaultLibraryId would break
// the moment any ensureConnected() -> connectTo() -> useLibrary(realHost) fired (a favorites or
// resume call), silently dropping us out of merged mode mid-session. The reserved
// '_merged' dir still holds merged-only state: the cached index and the mixed-host queue.
const MERGED_ID = '_merged'
let _mergedMode = false
function mergedMode () { return _mergedMode }

// The DEMO library (proposal 2026-07-28-app-review-demo): five CC0 tracks shipped inside the app,
// browsable and playable with NO host, no pairing, no network and no grant. It exists because an
// App Store reviewer - and anyone who installs the app before setting a server up - otherwise opens
// PearTune to a pairing wall and an app that appears to do nothing.
//
// Like mergedMode it is a MODE FLAG that browse consults, a THIRD branch beside the merged one. It
// is NOT a library in hosts.json, NOT a client, and it touches NOTHING in the security boundary:
// no grant store, no identity keypair, no pairing window. The catalog IS the flag - non-null means
// demo mode is on - and it lives in worklet/demo.js so it is unit-testable off-device.
//
// The manifest is persisted here so a relaunch rebuilds the catalog with no assets to resolve and
// no bytes to copy: the media is already in the audio cache (pinned) and the art store from the
// first enable.
const DEMO_FILE = path.join(DATA_DIR, 'demo.json')
let demoCatalog = null
let demoIds = new Set() // every demo track id + the cover id, for the lease gate
function demoMode () { return !!demoCatalog }

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
  cacheCap: DEFAULT_CACHE_CAP, downloadCellular: false,
  // The Recently Added shelf above the album grid. On by default - it is the one surface that
  // answers "what is new since I last looked", which is most of why people open a music app.
  showRecent: true,
  // The off-LAN relay backstop (proposal 2026-07-23). On by default so the app "just
  // works" for a 0%-punch user; a privacy maximalist turns it OFF for pure peer-to-peer,
  // accepting that a genuinely-unpunchable network will not connect. Read live per
  // connect in ensureSwarm's relayThrough fn, so a change applies without a restart.
  useRelay: true
}

// --- relay consent (proposal 2026-07-29-relay-audio-consent) -----------------
//
// Which libraries are reachable only THROUGH PeerLoom's relay, and therefore need
// consent before their AUDIO streams. Browse, search and artwork are deliberately NOT
// gated (decision 1): kilobytes against audio's megabytes, and gating them would mean
// a hard-NAT user opens a library to an empty screen and a dialog.
//
// RECORDED, not read off the socket, because there is no way to read it. The phone's
// own `dht.stats.relaying` reports 0 while actually relaying (measured 2026-07-23,
// Pixel over cellular; the relay node's stats were the ground truth), and hyperdht
// keeps the real flag (`c.relaySocket`) private with no accessor. So what we record is
// what we TOLD Hyperswarm to do, which is not the same claim.
//
// KNOWN LIMITATION, measured on the TCL 2026-07-29 and stated here rather than implied
// away: offering the relay is not the same as using it. hyperdht punches AND sets up the
// relay, and if the punch wins the connection is direct while we have already recorded
// "relayed". On the LAN that happens every time - a force-relay build logged
// relayed:true, the gate fired, the user was asked, and the relay node's byte counter
// never moved beyond its idle floor while 3.1 MB of audio was served. So the connection
// was direct and the prompt was unnecessary.
//
// The direction of that error is the safe one and that is why it is acceptable: we may
// ASK when we did not need to, and we never stream over the relay without asking.
//
// And on the network this is FOR, the record is right. Verified on the Pixel over
// cellular the same day, with the normal build and no force-relay: the direct dial
// failed (PEER_NOT_FOUND x4), both hosts came up relayed:true, the gate asked, and after
// consent the relay carried +19.0 MB of audio - against an idle floor of ~2-3 kB/s. So
// the false positive is a LAN artifact (the punch wins there), not the hard-NAT case.
// Tightening it would mean reading hyperdht internals, a worse trade than an occasional
// extra prompt on a network that did not need one.
//
// relayOffered  hostKeyZ -> did we hand Hyperswarm the relay key for this peer's most
//               recent connect ATTEMPT. Overwritten per attempt and read when the
//               connection lands, so it reflects the attempt that actually succeeded:
//               Hyperswarm tries direct first (null) and only escalates after a
//               HOLEPUNCH_ABORTED. A peer with no entry never had one offered, i.e. it
//               is direct - which is also the right answer for an inbound connection.
// relayAsked    libraryIds we have already emitted a prompt for, so ExoPlayer's many
//               range requests for one track produce ONE prompt. Cleared when the
//               consent changes, so a later decline-then-reconsider can ask again.
// relaySession  libraryId -> 'allow' | 'deny' for THIS worklet session only, never
//               written to disk. What the prompt's "Remember for this library" checkbox
//               being UNTICKED produces. The box is ticked by default, so the default
//               outcome of either button is the sticky one decision 3 asked for; this is
//               the escape hatch that avoids needing a third button (decision 2). Beats
//               the persisted value when set, so a session choice overrides a standing
//               one until the app restarts.
const relayOffered = new Map()
const relayAsked = new Set()
const relaySession = new Map()

// Is this library's connection riding the relay? Derived from relayOffered via the
// host's key, NOT cached per library.
//
// It WAS cached per library, set in onSwarmConnection. That is fragile in the one case
// that matters most: onSwarmConnection EARLY-RETURNS on the pairing path (the host is not
// in hosts.json yet, so its connection is routed to the in-flight handshake) before any
// recording happens, and the app then keeps using that very connection. A library's first
// session after pairing would therefore record nothing and the gate would read "not
// relayed" - and pairing is exactly when a user is most likely to be on the network that
// needs the relay.
//
// Not an observed failure: it is a code-path reading. The TCL run on 2026-07-29 could not
// distinguish it, because the Mac mini connection there was genuinely DIRECT (a LAN punch,
// logged relayed:false), so 'play' with no prompt was the correct answer, not a symptom.
// Deriving it here removes the dependency on which path the connection took, so the case
// cannot arise whether or not it ever did.
// `live` guards against a SECOND thing hardware found (TCL, 2026-07-29): relayOffered
// records the offer at DIAL time, including for a dial that then failed, so an offline
// library reads as relayed. Settings said "Reachable only through the relay right now"
// under a library labelled Offline - true of the attempt, nonsense as a statement about
// the library. Requiring a live connection makes the claim match what the row asserts.
function libraryRelayed (libraryId) {
  const h = loadHostsFile().hosts.find((x) => x.libraryId === libraryId)
  if (!h || relayOffered.get(h.hostKey) !== true) return false
  return !!clientFor(libraryId)
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
// ONE Hyperswarm for the whole worklet (proposal 2026-07-22 phase 2), riding the shared
// warm dht node above. EVERY library's connection comes from a PERSISTENT topic membership -
// Hyperswarm's ConnectionManager retries the hole-punch forever and holds the link open with
// keepalive, which is what makes off-LAN reliable (PearCircle's model). Nothing dht.connects a
// library any more; the swarm owns retry + reconnect for all of them (P2 finished what the
// 2026-07-22 transport proposal started). Created lazily in ensureSwarm().
let swarm = null
// The library currently being paired, if any. attach() skips the identity push for it - pair()
// sends that claim itself over the same connection, and racing the two minted duplicate persons
// (hardware, 2026-07-22).
let pairingLibId = null
// While a swarm-pair is mid-flight: { hostKeyZ, onConn }. The host being paired is not yet in
// hosts.json, so onSwarmConnection routes ITS connection to the pair handshake (phase 4) instead
// of attach*. Null the rest of the time.
let pairingTarget = null
// How long a caller (an RPC via ensureConnected, a cold-launch connect) waits for the FIRST
// live connection before giving up THIS wait. It bounds the wait only - the swarm membership
// persists past it and a connection that lands later still wires up (attach). So this is
// a UX bound, not a give-up: unlike the old per-dial budget, missing it does not stop retrying.
const ACTIVE_CONNECT_WAIT_MS = 20000
// How often to force a fresh swarm discovery while a library is DISCONNECTED. Hyperswarm's
// own reconnect backs off hard - after ~4 attempts a topic-discovered peer's retry timer returns
// null (stops) and even an explicit peer only gets a 10-MINUTE timer (lib/retry-timer.js). At the
// ~12% carrier hole-punch rate that is far too slow to land in the "1-2 min" the proposal wants.
// Each nudge (swarm.flush -> discovery refresh) clears the discovered set and re-emits the host,
// which resets its attempts and re-enqueues it (lib/peer-discovery.js clears _discovered every
// refresh; lib/index.js _handlePeer calls peerInfo._reset()), i.e. a fresh burst of attempts. So a
// ~10s nudge turns Hyperswarm's minutes-long lulls into a steady retry, faster than its own
// backoff. The timer is unref'd and only runs while foreground (a suspended worklet
// freezes it, which is correct - no point punching while backgrounded).
const ACTIVE_NUDGE_MS = 10000
// The DEFAULT library's client, and whether it is up. DERIVED, never stored (P3/P4): `client`,
// `currentHost` and `connected` used to be globals that attach/connect/drop had to keep in step
// with the link map, and a global that disagrees with the socket is how a caller ends up writing
// into a dead connection. There is one source of truth now - `links` - and these read it.
//
// defaultClient() answers null when there is nothing live; mustClient() is for the ~30 call sites
// that have just awaited ensureConnected() and would otherwise dereference null, and it fails with
// the same EUNREACHABLE shape those callers already handle.
function defaultClient () { return defaultLibraryId ? clientFor(defaultLibraryId) : null }
function defaultConnected () { return !!defaultClient() }
function mustClient () {
  const c = defaultClient()
  if (!c) {
    const e = new Error('could not reach the host')
    e.code = 'EUNREACHABLE'
    throw e
  }
  return c
}
let shim = null
let shimPort = null
let identity = null

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

// Forget what we learned about ONE host's age. Called on every fresh link - see the note there.
// Kept next to the marks themselves so a future third "unsupported" set is added in both places.
function clearUnsupportedFor (lib) {
  if (!lib) return
  sessionUnsupported.delete(lib)
  nowPlayingUnsupported.delete(lib)
}

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
// "I COULD NOT READ THIS" IS NOT "IT IS NOT THERE", and nowhere in the app does the difference
// matter more. Absent means a fresh install. Unreadable means something is wrong - and the two
// loaders below used to catch both and conclude "fresh install", which is a DESTRUCTIVE
// conclusion in each case:
//
//   - loadIdentity mints a new key pair. That key IS the grant every host holds, so one
//     unreadable file turns the phone into a stranger to every library it was ever paired
//     with, and no amount of relaunching brings it back.
//   - loadHostsFile returns the empty list, so a fully paired phone shows the ONBOARDING
//     screen and its owner reasonably concludes their library is gone (found on the TCL after
//     a reboot, 2026-08-02; PR #330 added a retry without ever establishing the cause).
//
// So: absent is ENOENT and nothing else. Everything else throws, and a loud failure the UI can
// show beats a quiet wrong answer that looks like data loss. bare-fs follows node's convention
// of putting the code on the error, but the message is checked too rather than betting the
// device identity on that holding.
function isMissing (e) {
  return e?.code === 'ENOENT' || /ENOENT|no such file/i.test(e?.message || '')
}

function readJsonIfPresent (file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (isMissing(e)) return undefined
    throw e
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error(`${file} is unreadable (${e.message}) - refusing to treat it as a fresh install`)
  }
}

// Write via a temp file and a rename, so a kill or a reboot mid-write cannot leave a TRUNCATED
// file behind. Without this, the crash-safety story ends at "and then it reads as a fresh
// install", which is exactly the outcome the loaders above now refuse to produce - there is no
// point hardening the read if the write can still manufacture the corrupt case.
function writeJsonAtomic (file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value))
  fs.renameSync(tmp, file)
}

function loadIdentity () {
  const raw = readJsonIfPresent(IDENTITY_FILE)
  if (raw) {
    return {
      publicKey: b4a.from(raw.publicKey, 'hex'),
      secretKey: b4a.from(raw.secretKey, 'hex')
    }
  }
  const kp = hcrypto.keyPair()
  writeJsonAtomic(IDENTITY_FILE, {
    publicKey: b4a.toString(kp.publicKey, 'hex'),
    secretKey: b4a.toString(kp.secretKey, 'hex')
  })
  log('identity:created', { dir: DATA_DIR })
  return kp
}

// The paired-host LIST (multi-host, 2026-07-19). hosts.json holds the canonical v2 shape
// { version, hosts:[{hostKey,libraryId,libraryName,addedAt}], activeHostKey }; the pure list
// logic (including the v1 single-object upgrade) lives in worklet/hosts.js so it is tested
// without a disk. Here we just read/normalize and write.
function loadHostsFile () {
  const raw = readJsonIfPresent(HOSTS_FILE)
  // normalize() is still total for anything it CAN read - a hand-edited file, a v1 file, a
  // stale active pointer - and that stays. What changed is that a file we could not read at
  // all no longer arrives here as "no libraries".
  return raw === undefined ? hostList.empty() : hostList.normalize(raw)
}

function saveHostsFile (f) {
  writeJsonAtomic(HOSTS_FILE, f)
}

// The currently-active host object, or null. Everything that used to call loadHost() (one
// host) now asks for the active one.
function loadDefaultHost () {
  return hostList.activeHost(loadHostsFile())
}

// Adopt a library as the DEFAULT one: point defaultLibraryId at it, ensure its per-host dir
// exists, migrate any pre-multi-host flat files into it, and (re)load its outbox. Cheap and
// idempotent - a no-op when the library is already active - so connect/init/switch can all
// call it freely. Called BEFORE any per-host state read/write.
function useLibrary (libraryId) {
  if (defaultLibraryId === libraryId) return
  defaultLibraryId = libraryId
  fs.mkdirSync(libDir(), { recursive: true })
  // The legacy flat-file migration only makes sense for a REAL host (the pre-multi-host layout held
  // one host's state); never fold root files into the _merged context - nor into the demo library,
  // which is not a host either and would swallow a real one's un-migrated state.
  if (libraryId !== MERGED_ID && libraryId !== demo.DEMO_LIBRARY_ID) migrateLegacyState()
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

  // The ART, which removeLibrary never reclaimed at all until now: the store had no index, so a
  // coverId on disk could not be traced back to the library it came from (proposal
  // 2026-07-29-persist-album-art). Same shape and same honesty as the audio purge above -
  // untagged rows predate the tag and are left to the cap rather than guessed at.
  try {
    const { removed, bytes, untagged } = artStore.removeLibrary(libraryId)
    if (removed || untagged) log('local:art-purged', { library: libraryId.slice(0, 8), removed, bytes, untagged })
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
// One-time sweep of art written before it was keyed by size (proposal
// 2026-07-29-persist-album-art). Those files have no '@<size>' suffix so nothing will ever
// read them again - they would sit there forever as dead bytes. Cheap, idempotent, and a no-op
// on a fresh install or after the first run.
try {
  const swept = artStore.sweepLegacy()
  if (swept) console.warn('[worklet] art:legacy-swept', swept)
} catch {}

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
  const c = defaultClient()
  if (flushing || !outbox.length || !c) return
  flushing = true
  try {
    while (outbox.length) {
      const entry = outbox[0]
      const call = clientCall(c, entry)
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
function stampAuth () { stampAuthFor(defaultLibraryId) }
// Cached audio plays only while the last successful authorization is inside the grace
// window. This is what makes a revoked device eventually lose its downloads without ever
// deleting a legitimate user's on a server hiccup.
function leaseValid () {
  const la = loadLastAuth()
  return la > 0 && (Date.now() - la) < LEASE_GRACE_MS
}

// Artwork usage, reported alongside the audio cache numbers so the UI needs no second call.
//
// The cap stays a COUNT and stays out of Settings (Tim, proposal 2026-07-29-persist-album-art),
// but the SPACE a count can reach is not obvious from the count: covers measured ~137 KB each on
// a real library, so the 4000-entry backstop is a few hundred MB. Showing the bytes is what stops
// that being invisible - there is no setting to tune, just a number you can see and a Refresh
// that reclaims it.
function artStats () {
  try { return { artBytes: artStore.totalBytes(), artCount: artStore.count() } } catch { return { artBytes: 0, artCount: 0 } }
}

// --- relay-audio consent gate (proposal 2026-07-29) --------------------------
//
// The shim calls this for every AUDIO request and nothing else. Returns 'play', 'ask'
// or 'refuse'; on 'ask' it also emits the prompt, once per library, because ExoPlayer
// range-requests one track many times and a prompt per range would be unusable.
//
// A null libraryId means the URL named no owning host, i.e. the default library - the
// shim cannot resolve that itself, which is why the substitution happens here.
function relayAudioGate ({ libraryId, trackId }) {
  const lib = libraryId || defaultLibraryId
  if (!lib) return 'play' // hostless (the demo library) - nothing of ours in the path

  const decision = relayAudioDecision({
    relayed: libraryRelayed(lib),
    // A session choice (the prompt with "Remember" unticked) beats the persisted one.
    consent: relaySession.get(lib) || hostList.relayAudioFor(loadHostsFile(), lib)
  })

  if (decision === 'ask' && !relayAsked.has(lib)) {
    relayAsked.add(lib)
    const h = loadHostsFile().hosts.find((x) => x.libraryId === lib)
    emit('relay:consent-needed', {
      libraryId: lib,
      libraryName: h ? labelFor(lib, h.libraryName) : null,
      trackId: trackId || null
    })
  }
  return decision
}

// Record the user's answer.
//
// remember=true  persists it: 'allow' | 'deny' are stored, anything else clears the field
//                back to "ask me again" (worklet/hosts.js setRelayAudio).
// remember=false session only - held in memory and gone on restart, which is what the
//                prompt's unticked checkbox means.
//
// Either way relayAsked is cleared, so a library that is later reconsidered can prompt
// again rather than sitting silently refused.
function setRelayAudioConsent (libraryId, value, remember = true) {
  const f = loadHostsFile()
  const h = f.hosts.find((x) => x.libraryId === libraryId)
  if (!h) return false
  const clean = (value === 'allow' || value === 'deny') ? value : ''
  if (remember) {
    // A remembered choice supersedes any session one, or the session value would keep
    // winning and the Settings row would show something that is not being obeyed.
    relaySession.delete(libraryId)
    saveHostsFile(hostList.setRelayAudio(f, h.hostKey, clean))
  } else if (clean) {
    relaySession.set(libraryId, clean)
  } else {
    relaySession.delete(libraryId)
  }
  relayAsked.delete(libraryId)
  log('relay:consent-set', { lib: libraryId.slice(0, 8), value: clean || 'ask', remember })
  return true
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

// --- demo mode --------------------------------------------------------------
//
// See the DEMO_FILE note at the top. Everything here is bookkeeping around
// worklet/demo.js, which owns the catalog build and the cache/art install.

function loadDemoRecord () {
  try {
    const o = JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8'))
    return o && o.manifest ? o : null
  } catch {
    return null
  }
}

function saveDemoRecord (rec) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(DEMO_FILE, JSON.stringify(rec))
}

// The synthetic library row the shell renders demo mode as. Deliberately NOT written to
// hosts.json - there is no host, no hostKey and no grant - so listHosts, switchHost and every
// connection path stay blind to it. init hands it straight to the UI as the active library so the
// app shell (navbar, browse, the player) renders exactly as it does for a real one, and `demo: true`
// is what lets the UI label it unmistakably rather than passing it off as a paired server.
function demoHostRow () {
  return {
    hostKey: null,
    libraryId: demo.DEMO_LIBRARY_ID,
    libraryName: demo.DEMO_LIBRARY_NAME,
    demo: true,
    pairedAt: null
  }
}

// Turn demo mode on for a built catalog: adopt it as the default library (so the queue, the
// settings and every other per-library path have a home on disk) and leave the blend, which
// nothing in demo mode can be part of.
function activateDemo (built) {
  demoCatalog = built
  demoIds = new Set([...built.tracks.map((t) => t.id), built.album.coverId].filter(Boolean))
  _mergedMode = false
  useLibrary(demo.DEMO_LIBRARY_ID)
}

// Does this id belong to the demo library? The lease gate asks: a demo track has no host, so
// there is no authorization that could ever be fresh, and gating it on one would mean the
// bundled music went dark after 14 days. See ensureShim.
function isDemoId (id) {
  return !!id && demoIds.has(id)
}

// Leave demo mode and give the ~18 MB back. Called by disableDemo and - the important one - by a
// successful pair: the moment a real library exists the demo has done its job, and leaving it in
// the switcher beside a real server is exactly the "looks like a paired library" the proposal
// forbids. Safe to call when demo mode is off.
function retireDemo (why) {
  // Rebuild from the saved record when demo mode is not currently ON. That is the case that
  // matters: a demo record can outlive its mode (a pair retires the demo at the moment init
  // decides not to activate it), and without this the media would be orphaned on disk with
  // nothing left in the app that could ever reach it.
  let cat = demoCatalog
  if (!cat) {
    const rec = loadDemoRecord()
    if (rec) cat = demo.buildDemoCatalog(rec.manifest, { stats: rec.stats || {} })
  }
  if (!cat) return { ok: true, retired: false }
  const r = demo.removeDemoMedia({ catalog: cat, cache: audioCache, artStore })
  try { fs.unlinkSync(DEMO_FILE) } catch {}
  purgeLibrary(demo.DEMO_LIBRARY_ID) // its queue and any other per-library state
  demoCatalog = null
  demoIds = new Set()
  if (defaultLibraryId === demo.DEMO_LIBRARY_ID) defaultLibraryId = null
  log('demo:retired', { why: why || null, removed: r.removed })
  return { ok: true, retired: true, ...r }
}

// --- connection -------------------------------------------------------------

// Build ONE PearTuneClient off the shared warm DHT node. Every library's connection is made here,
// so they all share the DHT and the session-superseded push wiring.
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
      // RIGHT stored host record, whichever library it is, the instant it happens - not on
      // the next reconnect/rebuild. Same effect as syncHostNames, just push-driven. The UI relabels
      // the header/switcher/merged chips off host:renamed for any hostKey.
      const lib = m.data?.libraryId
      const name = m.data?.libraryName
      const rec = lib && loadHostsFile().hosts.find((x) => x.libraryId === lib)
      if (rec && name && rec.libraryName !== name) {
        saveHostsFile(hostList.renameHost(loadHostsFile(), rec.hostKey, name))
        log('host:renamed-push', { hostKey: rec.hostKey })
        // labelFor, not `name`: we stored what the server said, but what the UI SHOWS is your
        // alias when you set one. Emitting the raw name here would flash the operator's name
        // over your alias until the next reload.
        emit('host:renamed', { hostKey: rec.hostKey, libraryName: labelFor(lib, name), hostName: name })
      }
    } else if (m?.kind === 'devices:changed') {
      // An owned host's device roster changed (a pair/revoke/delete/promote on its dashboard). Hand
      // it to the UI so an open You > Manage reloads that library's list live (carries libraryId so
      // the app reloads the RIGHT one in a blend). Owner-only by construction: the host pushes it
      // only to owner-scope grants.
      log('devices:changed', { library: String(m.data?.libraryId || '').slice(0, 8) })
      emit('devices:changed', m.data || {})
    } else if (m?.kind === 'request:new') {
      // Tier A notification (P3): the host only pushes request:new to OWNER devices, so if this
      // arrives we are an owner - hand it straight to the UI for a banner + badge. Rides whatever
      // channel it came in on, whichever library that is, which is why it lives here in the shared
      // client rather than on one connection.
      log('request:new', { kind: m.data?.kind ?? null })
      emit('request:new', m.data || {})
    } else if (m?.kind === 'request:resolved') {
      // The host pushed this to whoever filed the request, on every device they are signed in on.
      log('request:resolved', { status: m.data?.status ?? null })
      emit('request:resolved', m.data || {})
    } else if (m?.kind === 'playlists:changed') {
      // Another of this person's devices created, renamed, deleted or reordered a playlist. Same
      // deal as favorites: playlistList is a live host read behind a cache, so refreshing anything
      // here would just be a wasted round-trip before the one the UI is about to make.
      log('playlists:changed', { reason: m.data?.reason ?? null })
      emit('playlists:changed', m.data || {})
    } else if (m?.kind === 'requests:changed') {
      // The owner-side queue moved for a reason that is NOT a new arrival - a request was
      // withdrawn by whoever asked, or resolved on the dashboard. Only arrivals were ever pushed,
      // so Manage watched the queue grow and never shrink. No payload worth acting on: the list
      // is a live read and "something changed" is the whole message.
      log('requests:changed', { reason: m.data?.reason ?? null })
      emit('requests:changed', m.data || {})
    } else if (m?.kind === 'favorites:changed') {
      // ANOTHER of this person's devices favorited something. Straight through to the UI, which
      // re-reads: favorites() is already a live host read (its on-disk copy is only the offline
      // fallback), so refreshing anything HERE would just be a wasted round-trip before the one
      // the UI is about to make. The host does not send us our own writes.
      log('favorites:changed', { kind: m.data?.kind ?? null, on: m.data?.on ?? null })
      emit('favorites:changed', m.data || {})
    } else if (m?.kind === 'speaker:ended') {
      // A track we sent to a Home Assistant speaker finished (proposal 2026-08-01). The
      // speaker has no queue of its own, so THIS is the only signal that it is time to
      // send the next one - the app owns the queue and acts on this. Carries the entity
      // and the track that ended so a stale push (a speaker the user already moved off)
      // can be ignored rather than skipping the wrong track.
      log('speaker:ended', { entityId: m.data?.entityId ?? null })
      emit('speaker:ended', m.data || {})
    }
  }
  return c
}

// --- identity fan-out (multi-host) -------------------------------------------
//
// Your name, your device's name and your photo describe THE DEVICE, not one pairing, so
// every host you are paired to should show the same ones. They used to be pushed on the
// single active `client` only, which meant a second library kept whatever you were called
// when you paired it: Tim's Umbrel still read "Pixel" / "TCL" with no photo while the Mac
// had "Pixel2" / "TCL2" with both, and nothing would ever have reconciled them.
//
// Two halves, because a host that is offline when you rename cannot be told then:
//   1. setIdentity/setAvatar fan out to every host CONNECTED right now.
//   2. ensureHost pushes to a host the first time it connects in this run, so one that was
//      off catches up by itself.
// `identitySynced` is what stops (2) re-pushing on every read; a dropped connection
// clears its entry, so a reconnect re-syncs.
const identitySynced = new Set()

async function pushIdentityTo (c, libId) {
  const st = loadSettings()
  // Only send what we actually have. A blank name would otherwise ask the host to clear a
  // name it already knows, and an empty avatar means "remove the photo" - neither is what
  // an unrelated reconnect should do. Hence `undefined` rather than '': the host's setIdentity
  // tests `!== undefined` per field, so an omitted one is left exactly as it was.
  //
  // ALWAYS SENT, even with no names at all, because PLATFORM is the one thing here the device
  // knows better than the host and can only correct this way. Gating the whole call on a name
  // meant the devices most likely to be wrong were the ones that could never heal: a phone that
  // never had a name typed into it keeps whatever platform its grant was minted with, forever.
  // Caught on hardware (2026-07-28) - the iPhone reconnected to the Umbrel and stayed 'android'.
  await c.setIdentity({
    deviceName: st.deviceName || undefined,
    userName: st.userName || undefined,
    platform: PLATFORM
  })
  if (st.avatar) await c.setAvatar({ avatar: st.avatar })
  if (libId) identitySynced.add(libId)
}

// Best-effort, in parallel, to every library with a live connection. Never throws: a host that
// refuses or drops mid push just stays stale until it reconnects, and renaming must not fail
// because of it.
async function fanOutIdentity () {
  const targets = []
  for (const libId of links.keys()) {
    const c = clientFor(libId)
    if (c) targets.push([libId, c])
  }
  await Promise.allSettled(targets.map(([libId, c]) =>
    pushIdentityTo(c, libId)
      .catch((e) => log('identity:push-failed', { lib: String(libId).slice(0, 8), err: e?.message }))
  ))
}

// --- one link per library (P2, proposal 2026-07-26) -------------------------
//
// Every paired library - the default one included - has exactly one entry here, and every entry is
// reached the same way: a persistent Hyperswarm topic membership, a nudge loop while it is down, a
// watchdog probe while it is up. libraryId -> { host, client, discovery, nudgeTimer, waiters }.
// An offline library is simply an entry with no live client.
const links = new Map()

// The merged, deduped library INDEX (proposal 2026-07-19, §2): every connected host's full catalog,
// merged in memory, that merged mode serves browse/search/sort from. Null until first built.
// `mergedConnected` is the set of libraryIds that actually contributed to THIS index - a host that
// was offline at build time is simply absent (its tracks greyed), and it's what bestCopy() checks to
// route streaming (slice 4) to a copy that's actually reachable.
let mergedIndex = null
let mergedConnected = new Set()
// Which libraries contributed to the last LIVE build. Deliberately NOT the same thing as
// `mergedConnected`, which loadCachedIndex seeds from the PREVIOUS RUN's cache so the blend can
// render before anything connects. The attach handlers below need "did this host's catalog make
// it into the index we are actually serving THIS run", and answering that with the cached set
// said yes for a host that had not been reached yet - so the one rebuild that would have pulled
// it in was never requested. Starts empty on every launch, by design.
let mergedFresh = new Set()
// Routing lookups derived from the index (step 2, slice 4): map a bare trackId/coverId back to its
// owning host, so a play/art request in merged mode (whose URL may carry no libraryId, e.g. the UI's
// own artBase covers) still reaches the right server. trackByAnyId keys EVERY copy's id to the
// merged track, so bestCopy can fail the stream over to another host when the primary is offline.
let coverLib = new Map() // coverId -> libraryId
let trackLib = new Map() // any copy's trackId -> libraryId
let trackByAnyId = new Map() // any copy's trackId -> the merged track (for best-copy failover)
// The library the person has picked in the switcher, or null for "All libraries". The UI already
// sends this per-call for BROWSING; streaming needed its own copy because urlFor is called by the
// SHELL, which never sees the filter - which is precisely how "switch to this library, press play"
// ended up streaming from a different one (Tim, 2026-07-28). Held rather than passed so the ~5
// urlFor call sites, and the queue rebuild that re-resolves every item, cannot drift apart.
let preferredLib = null
let entityLib = new Map() // any album/artist/genre id (primary or a copy) -> its owning libraryId

// The live client for ONE library, whatever role it plays. Null when that library has no usable
// connection right now. Every caller in the worklet goes through here - there is no privileged
// "active client" any more, only a default library (see defaultLibraryId).
function clientFor (libraryId) {
  const e = links.get(libraryId)
  return e && e.client && e.client.conn && !e.client.conn.destroyed ? e.client : null
}

// Ensure ONE library is connected; returns its client. Identical for every library - join its
// topic, force a discovery lookup, keep nudging, and wait for the connection to land. Single-
// flight per library via its waiter list, so a burst of callers shares one attempt.
async function ensureLink (host) {
  const libId = host.libraryId
  const live = clientFor(libId)
  if (live) return live
  joinTopic(host)
  nudge(libId)      // force discovery now
  startNudge(host)  // keep punching until it lands
  await waitForLink(host)
  return clientFor(libId)
}

// The client for a SPECIFIC owned library - what lets Manage target any library you own, not just
// the default one (Tim: owning several, Manage only showed the last). No libraryId means the
// default library; every library resolves through the same ensureLink.
// The libraries this device OWNS and can currently reach, each with a live client. Backs both the
// Manage picker (ownedLibraries) and the aggregated owner request queue, so the two can never
// disagree about which libraries are in play. A library you own but are offline to cannot be
// managed, so it is omitted.
async function ownedLibraryList () {
  const out = []
  for (const h of loadHostsFile().hosts) {
    // One lookup for every library since P2 - the default one is no longer a special case. It
    // used to need an ensureConnected() here, which left ownedLibraries empty (and manageLib
    // null) whenever Manage opened before the `connected` flag caught up.
    const c = clientFor(h.libraryId)
    if (!c) continue
    try {
      const id = await c.getIdentity()
      if (id?.owner) out.push({ libraryId: h.libraryId, libraryName: labelFor(h.libraryId, id.libraryName || h.libraryName), active: h.libraryId === defaultLibraryId, client: c })
    } catch {}
  }
  return out
}

async function ownerClient (libraryId) {
  const lib = libraryId || defaultLibraryId
  const host = loadHostsFile().hosts.find((h) => h.libraryId === lib)
  if (!host) throw new Error('unknown library')
  return await ensureLink(host)
}

// Connect EVERY paired host in parallel for a merged read. An offline host resolves to a
// rejection (allSettled), so it's absent from the merge rather than failing the whole thing.
// Returns the libraryIds that connected.
async function ensureAll () {
  const hosts = loadHostsFile().hosts
  const settled = await Promise.allSettled(hosts.map((h) => ensureLink(h).then(() => h.libraryId)))
  return settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
}

// --- links: one connection per library --------------------------------------
//
// P2 of proposals/2026-07-26-one-connection-per-library.md. There used to be TWO tiers here: the
// "active" library, whose connection lived in the `client` global and was repaired by every RPC
// the app made, and the "pool", whose connections lived in a map and were repaired by a timer
// nobody kicked. The A/B (2026-07-26) proved that was the entire difference between a library
// coming back in 2 seconds and one going missing for 20 minutes.
//
// Now there is one map and one code path. `defaultLibraryId` still names a DEFAULT library - which
// one a caller means when it names none, and which one single-host mode shows - but it buys no
// connection privileges. The globals `client` / `currentHost` / `connected` survive as a VIEW of
// the default library's link, because ~39 call sites and the UI's host:connected events are
// written against them; P3 retires them.
//
// What this deletes, and why that is the point: demoteActiveToPool and promotePoolToActive existed
// only to MOVE a connection between the two tiers, and both were written to fix a bug that move
// caused (the 2026-07-23 orphan and the 2026-07-24 strand). With one tier there is nothing to move.

function joinTopic (host) {
  const libId = host.libraryId
  const s = ensureSwarm()
  let e = links.get(libId)
  // stuckSince: when a booked-but-never-opened dial was first seen for this library, 0 when there
  // is none. Drives the stuck-dial clear in startNudge - see stuckDial.
  if (!e) { e = { host, client: null, discovery: null, nudgeTimer: null, stuckSince: 0, lastTickAt: 0, waiters: [] }; links.set(libId, e) }
  e.host = host
  // server:false - the phone never announces, it only looks the host up and dials it, so this
  // adds no discoverability. s.join is idempotent per topic.
  if (!e.discovery) e.discovery = s.join(hostTopic(z32.decode(host.hostKey)), { server: false, client: true })
  return e
}

// Wire a client onto a swarm-provided connection. ONE attach for every library: the only thing the
// default library gets extra is the globals + the shim pointer + the host:connected event the UI
// listens for, and those are presentation, not transport.
async function attach (host, conn) {
  const libId = host.libraryId
  const e = joinTopic(host)
  const isDefault = libId === defaultLibraryId

  const c = makeClient()
  c.attach(conn, { libraryId: libId })
  if (e.client && e.client !== c) { try { e.client.close() } catch {} }
  e.client = c
  stopNudge(libId)
  stampAuthFor(libId) // a live connection is a fresh authorization for THIS library's lease
  flushOutboxFor(libId, c).catch(() => {})

  // NOT while this library is mid-pair: pair() sends the claim itself, over this same connection,
  // and pushing here raced it into DUPLICATE PERSONS (both sides saw "nobody holds this name" and
  // each minted one) - seen on hardware 2026-07-22.
  if (libId !== pairingLibId && !identitySynced.has(libId)) pushIdentityTo(c, libId).catch(() => {})

  conn.once('close', () => {
    if (e.client !== c) return // a newer attach already replaced it
    e.client = null
    identitySynced.delete(libId) // so a reconnect re-syncs rather than trusting a dead run
    if (libId === defaultLibraryId) {
      // Revoked, the host went away, or (most often) Android suspended this app in the background
      // and the link timed out. Indistinguishable from here, so do NOT guess.
      log('host:disconnected')
      emit('host:disconnected', { hostKey: host.hostKey })
    }
    // Every library's drop refreshes the blend - host:disconnected only speaks for the default one.
    if (mergedMode()) emit('merged:updated', mergedStatusData())
    startNudge(host) // the swarm redials on its own, but its backoff is far too slow off-LAN
  })

  log('link:connected', { lib: libId.slice(0, 8), role: isDefault ? 'default' : 'other', library: host.libraryName })

  // A FRESH LINK MEANS THE HOST MAY BE A DIFFERENT BUILD. Both "this host is too old for X" marks
  // are sticky for the worklet's lifetime, which is right while a connection lasts and wrong the
  // moment it is replaced: an operator who upgrades their box gets no benefit until every phone
  // that ever asked is restarted. Hit for real on 2026-07-28 - Tim deployed a host with
  // nowplaying.set, the dashboard stayed empty, and only force-stopping the app fixed it. Clearing
  // here costs one ENOMETHOD round-trip against a host that really is old, once per reconnect.
  clearUnsupportedFor(libId)

  if (isDefault) {
    // Point the (already-listening) shim at this client. Playback still flows THROUGH the live
    // connection for anything not cached, which is what makes a revoke stop the music.
    await ensureShim()
    if (clientFor(libId) === c) {
      emit('host:connected', {
        libraryName: labelFor(host.libraryId, host.libraryName), libraryId: host.libraryId, shimPort, artBase: shim.artBase()
      })
    }
    flushOutbox().catch(() => {}) // drain favorites/resume/counts queued while offline
  }

  if (mergedMode()) {
    emit('merged:updated', mergedStatusData())
    if (!mergedFresh.has(libId)) rebuildIndex().catch(() => {})
  }
  resolveWaiters(libId)
}

// What Hyperswarm actually believes about ONE host, for the logs. Reaching into swarm.peers and
// swarm._allConnections is private API, hence the try/catch: a diagnostic must never be the thing
// that breaks a connection. It answers the question the old logs could not - when a library is
// dark, is nothing being ATTEMPTED (no peer record, or attempts capped), or is every attempt
// failing? `conns` is the one that matters most: Hyperswarm dedups one connection per peer, so a
// stale entry there means rediscovery is a no-op no matter how hard we nudge.
function swarmDiag (hostKeyZ) {
  try {
    if (!swarm || !hostKeyZ) return {}
    const key = z32.decode(hostKeyZ)
    const pi = swarm.peers.get(b4a.toString(key, 'hex'))
    return {
      peer: pi
        ? `att:${pi.attempts},q:${pi.queued ? 1 : 0},w:${pi.waiting ? 1 : 0},ban:${pi.banned ? 1 : 0},prov:${pi.proven ? 1 : 0}`
        : 'none',
      conns: swarm._allConnections.has(key) ? 1 : 0,
      live: swarm.connections.size
    }
  } catch {
    return {}
  }
}

// Force a FRESH discovery lookup for one library. This is the load-bearing nudge: refresh() re-runs
// the DHT lookup, which clears the discovered set and re-emits the host, resetting its attempts and
// re-enqueuing it for a fresh connection burst. (swarm.flush() only WAITS for the current refresh -
// it does not start one when discovery is idle between its 10-min cycles - so it is the wrong tool.)
function nudge (libId) {
  const e = links.get(libId)
  if (e && e.discovery) { try { e.discovery.refresh({ client: true, server: false }).catch(() => {}) } catch {} }
}

// --- the stuck dial (Tim, 2026-07-30) ---------------------------------------
//
// A dial that STARTED and never finished blocks every future one, forever, and no amount of
// nudging can clear it. Straight from hyperswarm/index.js: _connect() adds the connection to
// _allConnections at DIAL time (line 216) and only to `connections` on 'open' (line 240), and
// its very first statement is `if (peerInfo.banned || this._allConnections.has(publicKey))
// return` (line 199). So while a never-opened entry sits there, the peer is deduped out of
// every reconnect attempt - discovery.refresh() re-enqueues it and _connect() drops it again.
//
// CAUGHT ON TIM'S PIXEL, 2026-07-30, which is the only reason this is a fix and not a theory:
//   08:36:27  ActivityManager: freezing 31156 com.peartune.debug
//   08:40:49  ActivityManager: freezing 31156 com.peartune.debug
//   08:49:50  START ... from com.android.launcher3 LAUNCH_SINGLE_TASK   (same pid resumed)
//   08:49:50  nudge:link {"conns":1,"live":0}          <- booked, not live: the stuck dial
//   08:49:50  method:failed {"method":"reconnect","err":"could not reach the host"}
// ANDROID'S CACHED-APP FREEZER IS THE TRIGGER, not a swipe-away. The process is frozen mid-dial,
// so the dial's own timers never fire; on resume the entry is still booked and nothing will ever
// close it. That is why ten scripted relaunches could not reproduce this - every adb way of
// closing an app KILLS the process, and a killed process has no swarm to leave a booking in.
//
// The existing link watchdog cannot see this one: it probes connections that are wired up to a
// client (worklet/link-health.js), and this one never got that far.
//
// Returns the stuck connection, or null. `live` is deliberately a per-connection check
// (swarm.connections.has) rather than the global count - with several libraries paired, another
// library's healthy connection would otherwise mask this one.
function stuckDial (hostKeyZ) {
  try {
    if (!swarm || !hostKeyZ) return null
    const conn = swarm._allConnections.get(z32.decode(hostKeyZ))
    if (!conn || swarm.connections.has(conn)) return null
    return conn
  } catch {
    return null
  }
}

// How long a booked-but-never-opened dial must persist before we destroy it. NOT zero, and this
// is the whole risk of the fix: a hole-punch legitimately in flight looks identical from here,
// and off-LAN punches have been measured at 8-28s (the Start9 runs, DONE 2026-07-29). Destroying
// one of those would abort a connection that was about to succeed, so the threshold sits above
// the slowest punch we have ever recorded rather than at the fastest self-heal we could get.
// Worst case is ~40s to recover (this is checked on the ACTIVE_NUDGE_MS tick), against never.
const STUCK_DIAL_MS = 30000
// A nudge tick this much later than scheduled means the worklet was not running in between -
// Android's cached-app freezer, or the device asleep. Three missed ticks, so ordinary timer jitter
// and a brief doze can never be mistaken for it.
const SUSPEND_GAP_MS = ACTIVE_NUDGE_MS * 3

// Keep nudging every ACTIVE_NUDGE_MS while a library is disconnected, so the hole-punch is retried
// steadily instead of stalling in Hyperswarm's 10-min backoff (see the constant). Self-cancels the
// moment a connection lands or the library is removed. Idempotent.
function startNudge (host) {
  const libId = host.libraryId
  const e = links.get(libId)
  if (!e || e.nudgeTimer) return
  const tick = () => {
    e.nudgeTimer = null
    if (!loadHostsFile().hosts.some((h) => h.libraryId === libId)) return // library removed
    if (clientFor(libId)) return // landed
    log('nudge:link', { lib: libId.slice(0, 8), net: networkType, ...swarmDiag(host.hostKey) })
    // Clear a stuck dial before nudging, or the nudge is a no-op (see stuckDial).
    //
    // WE WERE SUSPENDED is the precise signal, and it is better than any timer: this tick is
    // supposed to arrive every ACTIVE_NUDGE_MS, so a much larger gap means the process was
    // frozen (or the device slept) in between - which is exactly the condition that strands a
    // dial. A punch that was in flight across a freeze is dead regardless, so there is nothing
    // to lose by clearing it, and clearing it AT ONCE is what makes the app connect the moment
    // Tim opens it rather than 30-40s later.
    const now = Date.now()
    const stuck = stuckDial(host.hostKey)
    if (!stuck) e.stuckSince = 0
    else if (!e.stuckSince) e.stuckSince = now
    // The rule itself is in worklet/link-health.js, with the rest of the link-repair decisions
    // and its own tests - this is only the plumbing that finds the connection and destroys it.
    const why = stuckDialAction({
      hasStuck: !!stuck,
      stuckSince: e.stuckSince,
      lastTickAt: e.lastTickAt,
      now,
      suspendGapMs: SUSPEND_GAP_MS,
      holdMs: STUCK_DIAL_MS
    })
    e.lastTickAt = now
    if (why) {
      log('link:stuck-dial', { lib: libId.slice(0, 8), why, heldMs: now - e.stuckSince })
      e.stuckSince = 0
      // Its 'close' handler is hyperswarm's own (index.js:248): it removes the entry from
      // _allConnections and re-queues the peer, which is exactly what unblocks the next dial.
      try { stuck.destroy() } catch {}
    }
    nudge(libId)
    e.nudgeTimer = setTimeout(tick, ACTIVE_NUDGE_MS)
    if (e.nudgeTimer.unref) e.nudgeTimer.unref()
  }
  e.nudgeTimer = setTimeout(tick, ACTIVE_NUDGE_MS)
  if (e.nudgeTimer.unref) e.nudgeTimer.unref()
}

function stopNudge (libId) {
  const e = links.get(libId)
  if (e && e.nudgeTimer) { clearTimeout(e.nudgeTimer); e.nudgeTimer = null }
}

// --- connection watchdog (2026-07-26) ---------------------------------------
//
// Self-healing for every library. See worklet/link-health.js for why: a connection nothing is
// using is never proved by traffic, so a socket that died while the worklet was suspended still
// reads as connected - the nudge stops (it thinks it landed), the blend claims the library is
// there, and Hyperswarm will not redial because it dedups one connection per peer.
let watchdogTimer = null

function startWatchdog () {
  if (watchdogTimer) return
  watchdogTimer = setInterval(() => { watchdogTick().catch(() => {}) }, WATCHDOG_MS)
  if (watchdogTimer.unref) watchdogTimer.unref()
}

async function watchdogTick () {
  const actions = linkActions({
    hosts: loadHostsFile().hosts,
    defaultLibraryId,
    isLive: (libId) => !!clientFor(libId),
    provenAt: (libId) => { const c = clientFor(libId); return c ? c.lastActivityAt : 0 },
    now: Date.now()
  })
  await Promise.allSettled(actions.map(async ({ host, libraryId: libId, active, action }) => {
    const role = active ? 'default' : 'other'
    if (action === 'redial') {
      // Idempotent by design: joinTopic re-uses an existing discovery session and startNudge
      // returns early when a loop is already running, so this only DOES anything when nothing was
      // reaching for this library at all.
      const e = links.get(libId)
      const stalled = !e || !e.nudgeTimer
      joinTopic(host)
      startNudge(host)
      if (stalled) {
        // The interesting case, and the one worth a line in the log. If this fires repeatedly in
        // the field, a nudge loop is dying somewhere we have not found yet - and the watchdog is
        // what keeps that from being an outage.
        log('link:watchdog', { lib: libId.slice(0, 8), role, state: 'stalled', ...swarmDiag(host.hostKey) })
        nudge(libId)
      }
      return
    }
    // 'probe': prove a connection that traffic has not proved lately. A ping that never answers
    // means the socket is dead even though the object is not destroyed - destroy it so the close
    // handler greys the library, restarts its nudge, and frees Hyperswarm to redial the peer.
    const c = clientFor(libId)
    if (!c) return
    try {
      await Promise.race([
        c.ping(),
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error('ping timeout')), PING_TIMEOUT_MS)
          if (t.unref) t.unref()
        })
      ])
    } catch (err) {
      log('link:watchdog', { lib: libId.slice(0, 8), role, state: 'zombie', err: err && err.message, ...swarmDiag(host.hostKey) })
      try { c.conn.destroy() } catch {}
    }
  }))
}

function resolveWaiters (libId) {
  const e = links.get(libId)
  if (!e || !e.waiters) return
  const w = e.waiters; e.waiters = []
  for (const r of w) r.resolve()
}

// Await a live connection to one library, with a UX timeout so a caller does not hang forever when
// the host is unreachable. The timeout bounds only THIS wait - the swarm membership persists, so a
// connection that lands later still wires up via attach().
function waitForLink (host, timeout = ACTIVE_CONNECT_WAIT_MS) {
  const libId = host.libraryId
  if (clientFor(libId)) return Promise.resolve()
  const e = links.get(libId) || joinTopic(host)
  return new Promise((resolve, reject) => {
    const entry = {}
    const timer = setTimeout(() => {
      const i = e.waiters.indexOf(entry)
      if (i >= 0) e.waiters.splice(i, 1)
      const err = new Error('could not reach the host')
      err.code = 'EUNREACHABLE'
      reject(err)
    }, timeout)
    if (timer.unref) timer.unref()
    entry.resolve = () => { clearTimeout(timer); resolve() }
    e.waiters.push(entry)
  })
}

// Leave a library's topic and tear its link down (remove-library / forget). Stops the swarm trying
// to reach it, stops its nudge, closes its client. Idempotent. NB this is for libraries we are
// DONE with - a mere view change must not call it, or the next tap pays for a fresh hole-punch.
function dropLink (libId) {
  const e = links.get(libId)
  if (!e) return
  stopNudge(libId)
  if (swarm && e.host) { try { swarm.leave(hostTopic(z32.decode(e.host.hostKey))) } catch {} }
  if (e.client) { try { e.client.close() } catch {} }
  links.delete(libId)
}

async function closeAllLinks () {
  for (const libId of [...links.keys()]) dropLink(libId)
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
  const c = clientFor(libraryId)
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
// must not touch any live link), says device.leave, and drops
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
// (ensureAll - offline ones absent), pull each one's FULL catalog off its client, and
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

// Coalesced, with a follow-up run when a request lands mid-build - see worklet/rebuild-gate.js
// for why a plain single-flight silently loses exactly the rebuild that mattered.
const rebuildGate = createRebuildGate(buildMergedIndex)
function rebuildIndex () { return rebuildGate.request() }

async function buildMergedIndex () {
  const libIds = await ensureAll() // connect all; offline hosts absent from this list
  const hosts = loadHostsFile().hosts.filter((h) => libIds.includes(h.libraryId))
  // Pull each connected host's catalog off its client. allSettled so one host dropping
  // mid-fetch drops just that host from the blend, not the whole rebuild.
  const settled = await Promise.allSettled(hosts.map((h) => {
    const c = clientFor(h.libraryId)
    if (!c) return Promise.reject(new Error('not connected'))
    return catalog.fetchCatalog(c, h.libraryId)
  }))
  const catalogs = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
  mergedIndex = merge.buildIndex(catalogs)
  mergedConnected = new Set(catalogs.map((c) => c.libraryId))
  mergedFresh = new Set(mergedConnected) // what THIS run actually reached, for the attach guards
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
}

// Pick up library RENAMES for the given connected hosts (the live-rename push covers one library;
// this covers every host in the blend on a rebuild). Each host's identity.get carries its current name; if it differs from our
// stored record, persist it and tell the UI (chips + switcher relabel). Best-effort per host.
async function syncHostNames (hosts) {
  await Promise.allSettled((hosts || []).map(async (h) => {
    const c = clientFor(h.libraryId)
    if (!c) return
    const remote = await c.getIdentity().catch(() => null)
    const name = remote && remote.libraryName
    const rec = loadHostsFile().hosts.find((x) => x.libraryId === h.libraryId)
    if (name && rec && rec.libraryName !== name) {
      saveHostsFile(hostList.renameHost(loadHostsFile(), rec.hostKey, name))
      emit('host:renamed', { hostKey: rec.hostKey, libraryName: labelFor(h.libraryId, name), hostName: name })
    }
  }))
}

// The display name for ONE library: YOUR alias if you set one, else the host's own name, then
// disambiguated when another paired library shares it (worklet/hosts.js libraryLabels - "My
// Library" twice becomes "My Library #jud4" / "#rxtj", a lone name is untouched). Every
// user-facing payload below goes through this, INCLUDING the host:renamed emits - an operator
// renaming their library must not flash their name over your alias. The STORED libraryName stays
// exactly what the host said, so clearing an alias reveals the server's current name.
function labelFor (libraryId, fallback) {
  return hostList.libraryLabels(loadHostsFile().hosts).get(libraryId) || fallback || 'Library'
}

// The paired libraries with the active one flagged (Settings' switcher). A module function so
// methods can call it without `this` - the IPC dispatch invokes methods unbound, so `this` is
// undefined inside them.
function listHostsData () {
  // In demo mode the ONE row is the demo library, flagged so the switcher can name it
  // unmistakably. It is not in hosts.json and never will be (see demoHostRow), so it has to be
  // supplied here rather than read - and the moment a real library is paired the demo retires,
  // so the two can never appear side by side.
  if (demoMode()) return { hosts: [{ ...demoHostRow(), hostName: demo.DEMO_LIBRARY_NAME, active: true }], activeHostKey: null }
  const f = loadHostsFile()
  const labels = hostList.libraryLabels(f.hosts)
  return {
    hosts: f.hosts.map((h) => ({
      ...h,
      libraryName: labels.get(h.libraryId) || h.libraryName,
      // The host's OWN name, unaliased and unsuffixed. Settings shows it under a row you have
      // aliased ("Your server calls it X") so the mapping is discoverable and a server-side
      // rename is never invisible; `alias` rides along in the spread above for the editor.
      hostName: h.libraryName,
      active: h.hostKey === f.activeHostKey,
      // Relay consent (proposal 2026-07-29). `relayAudio` rides along in the spread above when
      // set; these two are what the Settings row needs to say something true:
      //   relayed      is this library CURRENTLY reachable only through the relay - so the row
      //                can stay quiet on a library that never needs the choice
      //   relayConsent the three-way, with absent normalised to 'ask' so the UI has no special case
      relayed: libraryRelayed(h.libraryId),
      relayConsent: h.relayAudio || 'ask'
    })),
    activeHostKey: f.activeHostKey
  }
}

// The per-library status the UI renders the source-filter chips + greying from (see the mergedStatus
// method). A module function so a background rebuildIndex can push it without the methods object.
// `connected` is LIVE link connectivity (connectedLibs), not the build-time mergedConnected, so a
// revoke - which destroys that library's connection instantly - greys it the moment the UI re-queries
// (on host:disconnected), without waiting for a full index rebuild. `trackCount` stays index-based:
// how many of the host's tracks are in the CURRENT blend (a host can be greyed/unreachable yet still
// have its last-built tracks browsable).
function mergedStatusData () {
  const hosts = loadHostsFile().hosts
  const labels = hostList.libraryLabels(hosts)
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
      libraryName: labels.get(h.libraryId) || h.libraryName,
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

// The connected client for one library, ensured (self-heals a dropped connection). Used both by a
// DETAIL read (an album's track list the browse index doesn't hold) and by streaming routing.
async function ensureHostById (libraryId) {
  const host = loadHostsFile().hosts.find((h) => h.libraryId === libraryId)
  if (!host) throw new Error('Unknown library.')
  return await ensureLink(host)
}

// The libraryIds with a LIVE connection right now (not merely in the last index build) - the
// connected-set bestCopy() checks so streaming routes to a copy that's actually reachable.
function connectedLibs () {
  const s = new Set()
  for (const libId of links.keys()) if (clientFor(libId)) s.add(libId)
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
// `merged: true`; single mode -> the default library's client. sessionTarget() is SYNC (reads
// current link state, used by the ~4s heartbeat so it never dials); sessionReady() ensures the
// connection first (used by activate/takeover/info, which the user just triggered). Either yields
// c: null offline. `lib` is the target host's libraryId - the key handoff support is scoped to
// (the elected home in merged mode, the default library in single mode). Callers gate on
// sessionSupportedFor(lib).
// THE ELECTED HOME IN BOTH MODES (proposal 2026-07-30-session-home-regardless-of-view). `merged`
// still selects the SCOPE - which row, `session:` or `session:merged:` - and only the HOST is
// unified. This used to send a focused device's token to whichever library it was focused on,
// which meant the cross-scope arbitration in #283 only applied when that library happened to BE
// the elected one: always true with one library, about a coin flip with two. The rig that proved
// #283 passed because the focused phone was pointed at the elected host.
//
// A focused device's queue therefore lands on the elected host rather than the one it is reading.
// That is already what a merged queue does - the host stores a queue opaquely and never
// dereferences a trackId - so nothing host-side has to know.
function sessionTarget () {
  const lib = hostList.sessionHost(loadHostsFile(), connectedLibs(), defaultLibraryId)
  return { c: lib ? clientFor(lib) : null, merged: mergedMode(), lib }
}
async function sessionReady () {
  // Ensure the ELECTED host is up, not merely the focused one - with 2+ libraries they differ, and
  // ensureConnected only ever wakes the default. One library: identical to before.
  if (loadHostsFile().hosts.length > 1) await ensureAll().catch(() => {})
  else await ensureConnected()
  return sessionTarget()
}

// We are PLAYING but do not hold the session token: ask the host what the truth is and act on it.
// Returns true when the caller should report lostSession (the shell then hands off, which stops
// us). The DECISION is pure and lives in worklet/session.js with the reasoning; this is the I/O
// around it. Proposal 2026-07-30-one-device-plays.
async function reconcileSession (tgt) {
  try {
    const s = await tgt.c.sessionGet(tgt.merged ? { merged: true } : undefined)
    if (s) sessionGen = s.generation
    const verdict = sessionVerdict(s)
    if (verdict === session.ADOPT) { sessionActive = true; return false }
    if (verdict === session.STOP) {
      log('session:reconcile-lost', { merged: tgt.merged, generation: s.generation })
      return true
    }
    const r = await tgt.c.sessionClaim({ generation: s?.generation || 0, merged: tgt.merged })
    if (r?.ok) {
      sessionActive = true
      sessionGen = r.session.generation
      log('session:reconcile-claimed', { merged: tgt.merged, generation: r.session.generation })
    }
    return false
  } catch (e) {
    if (e?.code === 'ENOMETHOD') markSessionUnsupported(tgt.lib)
    return false // offline / transient: keep playing, try again on the next heartbeat
  }
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
    const c = clientFor(lib)
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

// The connected client for the library that owns a track (merged mode), or null - so per-track
// state writes (resume/count) and reads route to the same host that holds the track.
function trackClient (trackId) {
  const lib = favHost('track', trackId)
  return lib ? clientFor(lib) : null
}

// Resolvers the shim consults for a URL that carries no libraryId (the UI's own artBase covers, or a
// single-segment track URL) - null outside merged mode, so single-host behaviour is unchanged.
function libForTrack (trackId) { return mergedMode() ? (trackLib.get(trackId) || null) : null }

// Tell the library that OWNS the current track what we are playing, so its dashboard can answer
// "is anyone listening to my music?" (proposal 2026-07-28-nowplaying-from-the-phone).
//
// Sent to exactly ONE host - the owner of the track in hand - because that is the only library the
// statement is true of. When the next track belongs to a different library, the previous host stops
// being told and its row expires by itself, which is why there is no stop message to lose. A host
// too old to know the method says NO_METHOD once and is never asked again.
const nowPlayingUnsupported = new Set()
let lastNowPlayingLib = null

// WHAT THE SPEAKER IS DOING, when a cast is on. The phone's own snapshot says `playing:
// false` for the whole of a cast - it is deliberately muted and paused - so the dashboard
// showed "Paused" while music filled the room (Tim, 2026-08-02). Tracked here because every
// speaker call already passes through this module, so nothing else has to be told.
let castingOn = false
let castingPaused = false

async function reportNowPlaying (snapshot) {
  const cur = snapshot && Array.isArray(snapshot.items) ? snapshot.items[snapshot.index || 0] : null
  // WHICH COPY IS ACTUALLY PLAYING, not which one owns the merged id. `libForTrack` answers the
  // latter: the merged track carries the PRIMARY copy's id, so a song held by two libraries was
  // always reported to the primary even when the bytes came from the other one. That was invisible
  // until the switcher became a source control - pick the non-primary library, play, and its
  // dashboard stayed empty while the primary's lit up (Tim, 2026-07-28). routeTrack is the same
  // resolution urlFor uses, so the row now names whoever really served the audio.
  const route = cur ? routeTrack({ trackId: cur.id, copies: cur.copies }) : null
  const lib = cur ? (route?.libraryId || libForTrack(cur.id) || defaultLibraryId) : null
  // Moved to a track another library owns: tell the PREVIOUS one to forget us now rather than
  // leaving its dashboard to time the row out.
  if (lastNowPlayingLib && lastNowPlayingLib !== lib) {
    const prev = clientFor(lastNowPlayingLib)
    if (prev) prev.nowPlaying({ trackId: null }).catch(() => {})
  }
  lastNowPlayingLib = lib
  if (!lib || nowPlayingUnsupported.has(lib)) return
  const c = clientFor(lib)
  if (!c) return
  try {
    await c.nowPlaying({
      trackId: cur.id,
      title: cur.title || null,
      artist: cur.artist || null,
      // While casting, report the SPEAKER. The phone is muted and paused throughout, and
      // saying so would be true of the phone and false of the music.
      playing: castingOn ? !castingPaused : !!snapshot.playing
    })
  } catch (e) {
    if (e?.code === 'ENOMETHOD') nowPlayingUnsupported.add(lib)
  }
}
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
    const c = merge.bestCopy({ copies }, connected, preferredLib)
    return c ? { libraryId: c.libraryId, id: c.id } : null
  }
  const m = trackByAnyId.get(trackId)
  if (m) { const c = merge.bestCopy(m, connected, preferredLib); if (c) return { libraryId: c.libraryId, id: c.id } }
  if (libraryId) return { libraryId, id: trackId }
  return null
}

// MID-SONG FAILOVER (proposal 2026-07-27). The copy to continue from when a stream dies mid-track:
// another library that holds the same song and is reachable RIGHT NOW. `identical` says whether its
// bytes line up, which is what lets the shim splice into the same HTTP response instead of stopping
// the music. Null when nothing else has this track - then the old behaviour stands.
function altCopyFor (trackId, failedLibraryId) {
  const track = trackByAnyId.get(trackId)
  if (!track) return null
  return pickAltCopy({ track, failedLibraryId, connected: connectedLibs(), currentId: trackId })
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
    log,
    // The DEFAULT library's client, resolved per request and revived if it is down. Replaces the
    // held client + setClient() pair (P3): nothing to keep in step, so nothing to get stale.
    defaultClient: async () => {
      await ensureConnected()
      return defaultLibraryId ? clientFor(defaultLibraryId) : null
    },
    // Read fresh each request so a Settings change (or a wifi->cellular flip) applies
    // to the next track without rebuilding the shim.
    quality: (trackId, suffix) => streamParams(loadSettings(), networkType, suffix, PLATFORM),
    cache: audioCache,
    artStore,
    // The lease gate: a cached track is only served from disk while authorization is
    // fresh. Expired (a revoked or long-offline device) falls through to the live path.
    leaseOk: leaseValid,
    // The relay-consent gate (proposal 2026-07-29). AUDIO ONLY - the shim does not call
    // this for art. Owns the prompt and its debouncing, because the shim is the wrong
    // place to know about IPC.
    audioGate: relayAudioGate,
    // ...unless the id has no host to be authorized BY. Only the demo library is hostless, and a
    // real library's ids are never in demoIds, so every existing path is untouched.
    hostless: isDemoId,
    // Merged-mode streaming routing (step 2, slice 4). hostClient returns the connected client
    // for a URL that names its owning host; libForTrack/libForCover resolve a bare id to its host
    // for a URL that doesn't (the UI's own artBase covers). All three are inert in single-host mode
    // (no libraryId in the URL, resolvers return null), so that path is unchanged.
    hostClient: ensureHostById,
    libForTrack,
    libForCover,
    // Which library a browse-fetched cover belongs to, so the art store can tag it and a later
    // removeHost can reclaim it (proposal 2026-07-29-persist-album-art). In merged mode
    // libForCover knows; in single-host mode the URL names no library and the default one is
    // the answer. Returns null rather than guessing when neither can say, and an untagged row
    // is simply never claimed by a per-library purge.
    artLibrary: (coverId) => libForCover(coverId) || defaultLibraryId || null,
    // Mid-song failover: which copy to continue from, and - when the copies are not byte-identical
    // and a splice is impossible - a nudge to the shell to re-open the track on the other library
    // at the same TIMESTAMP. The shim cannot restart a player; only the shell can.
    altCopy: altCopyFor,
    onRehost: ({ trackId, from, to, bytesServed, size }) => {
      log('play:rehost', { track: String(trackId).slice(0, 8), to: String(to.libraryId).slice(0, 8) })
      emit('play:rehost', {
        trackId,
        fromLibraryId: from || null,
        libraryId: to.libraryId,
        id: to.id,
        // How far the old copy had been served, so the shell can seek proportionally when the new
        // copy is a different encode (different byte length, same music).
        fraction: size ? Math.max(0, Math.min(1, bytesServed / size)) : null
      })
    }
  })
  shimPort = await shim.listen()
  return shimPort
}

// The ONE Hyperswarm, riding the shared warm dht node (proposal 2026-07-22 phase 2).
// Created lazily so a cold launch with no paired host never stands it up.
function ensureSwarm () {
  if (!swarm) {
    if (!dht) dht = new HyperDHT()
    // relayThrough is a FUNCTION, not a static key, so the privacy toggle + the baked
    // relay key are read LIVE on every connect (Hyperswarm calls it per dial). Direct-
    // first: it returns null on the first attempt and only yields the relay key after
    // Hyperswarm sets force=true on a HOLEPUNCH_ABORTED (proposal 2026-07-23). With no
    // relay key baked yet, or the toggle off, it always returns null - a pure no-op.
    swarm = new Hyperswarm({
      keyPair: identity,
      dht,
      relayThrough: (force, s, peerInfo) => {
        const key = relayThroughFor({
          force,
          randomized: !!(s && s.dht && s.dht.randomized),
          useRelay: loadSettings().useRelay !== false,
          relayKey: RELAY_PUBLIC_KEY
        })
        // Record WHAT WE DECIDED for this peer, so the audio gate can ask later whether
        // a library is only reachable through the relay (proposal 2026-07-29). See
        // relayOffered for why this is recorded rather than read off the socket.
        //
        // peerInfo is absent on the SERVER-side relayThrough (hyperdht calls that one
        // with no arguments), where there is no peer to attribute a decision to, and it
        // is absent on the client side too unless patches/hyperswarm+4.17.0.patch is
        // applied. That patch is what forwards it; without it nothing is ever recorded
        // and nothing is ever gated, which is exactly the silent failure
        // test/relay-consent.test.js exists to catch.
        if (peerInfo && peerInfo.publicKey) relayOffered.set(z32.encode(peerInfo.publicKey), !!key)
        return key
      }
    })
    swarm.on('connection', onSwarmConnection)
    // One watchdog for the whole worklet, started with the swarm because every path that
    // needs it (init, pair, add-library, switch-library) goes through here. It no-ops outside
    // merged mode, so a single-library phone pays a comparison every 30s and nothing else.
    startWatchdog()
  }
  return swarm
}

// Every connection the swarm lands arrives here. Map it by the Noise-authenticated remote key to
// the library it belongs to and wire a client onto it. One route for every library (P2); anything
// we are not paired with is unexpected and dropped.
function onSwarmConnection (conn, info) {
  conn.on('error', () => {}) // a peer vanishing is normal, not an event
  const remoteHex = z32.encode(info.publicKey)
  // A pairing connection: the host being paired is not in hosts.json yet, so route its connection
  // to the in-flight pair handshake before the grant-based routing below (phase 4).
  if (pairingTarget && remoteHex === pairingTarget.hostKeyZ) {
    log('swarm:pair-connection', { host: remoteHex.slice(0, 8) })
    return pairingTarget.onConn(conn)
  }
  const host = loadHostsFile().hosts.find((h) => h.hostKey === remoteHex)
  if (!host) {
    log('swarm:unexpected-peer', { peer: remoteHex.slice(0, 8) })
    try { conn.destroy() } catch {}
    return
  }
  // Log whether this connection is relayed (proposal 2026-07-29). Read, not stored: see
  // libraryRelayed() for why caching it here was wrong.
  log('swarm:connection', { host: remoteHex.slice(0, 8), relayed: relayOffered.get(remoteHex) === true })
  attach(host, conn).catch((e) => log('attach:failed', { host: remoteHex.slice(0, 8), err: e && e.message }))
}

// Make `host` the DEFAULT library and make sure it is connected. Since P2 this neither tears down
// the previous default's connection nor dials anything special: every library is connected the same
// way, so "switching" is a pointer move plus the ordinary ensureLink.
async function connectTo (host) {
  useLibrary(host.libraryId)
  const e = links.get(host.libraryId)
  // Already connected (it was just another library a moment ago): adopt it into the default slot
  // rather than waiting for a 'connection' event that will never come - Hyperswarm dedups one
  // connection per peer. This is the case demoteActiveToPool/promotePoolToActive used to hand-roll.
  if (e && clientFor(host.libraryId)) {
    // Nothing to assign: making this the default library IS useLibrary(), above. The link map
    // already holds the connection, so defaultClient() answers with it from here on.
    await ensureShim()
    log('link:default', { lib: host.libraryId.slice(0, 8), library: host.libraryName })
    emit('host:connected', {
      libraryName: labelFor(host.libraryId, host.libraryName), libraryId: host.libraryId, shimPort, artBase: shim.artBase()
    })
    flushOutbox().catch(() => {})
    return { ...host, shimPort }
  }
  await ensureLink(host)
  return { ...host, shimPort }
}

// Pair over the swarm (phase 4). Join the host's discovery topic, nudge it steadily (so an off-LAN
// pair keeps punching instead of giving up), and run the pair handshake on the connection the swarm
// lands - routed here via pairingTarget because the host is not in hosts.json yet. Returns
// { paired, conn }: the pair result AND the live connection, which the caller REUSES for the media
// channel so an off-LAN pair does not pay for a second hole-punch (conn is null when we short-circuit
// an already-connected host). The retry persistence + connection reuse are the win over the old
// dht.connect pair (3 tries / 8s): pairing now has the same reliability as media, with no second punch.
async function pairViaSwarm (link, { label = 'phone', platform = PLATFORM, timeout = 60000 } = {}) {
  const parsed = parseLink(link) // { rv, hostKey: buffer, name }
  const hostKeyZ = z32.encode(parsed.hostKey)

  // Already connected to this host? Then it is already paired + granted (the live connection proves
  // the grant), so re-pairing is redundant - and Hyperswarm dedups one connection per peer, so we
  // could not get a fresh pair connection to it anyway. Short-circuit instead of waiting out the
  // whole timeout. (The common re-pair - a host you REMOVED then re-add - is disconnected, so it
  // takes the real path below.)
  const libId = deriveLibraryId(parsed.hostKey)
  if (clientFor(libId)) {
    const rec = loadHostsFile().hosts.find((h) => h.libraryId === libId)
    return { paired: { hostKey: parsed.hostKey, libraryId: libId, libraryName: rec ? rec.libraryName : parsed.name }, conn: null }
  }

  const c = makeClient() // just for the pair handshake; attach() builds the media client
  const s = ensureSwarm()
  const topic = hostTopic(parsed.hostKey)
  const discovery = s.join(topic, { server: false, client: true })

  let nudgeT = null
  const nudge = () => {
    try { discovery.refresh({ client: true, server: false }).catch(() => {}) } catch {}
    nudgeT = setTimeout(nudge, ACTIVE_NUDGE_MS)
    if (nudgeT.unref) nudgeT.unref()
  }
  const cleanup = (leaveTopic) => {
    pairingTarget = null
    if (nudgeT) { clearTimeout(nudgeT); nudgeT = null }
    // On success we KEEP the topic joined - the caller REUSES this connection (and its membership)
    // for the media channel. On failure we leave it so we stop reaching for a host we never paired.
    if (leaveTopic && swarm) { try { swarm.leave(topic) } catch {} }
  }

  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false
      const deadline = setTimeout(() => {
        if (!settled) { settled = true; reject(Object.assign(new Error('could not reach the host to pair'), { code: 'EUNREACHABLE' })) }
      }, timeout)
      if (deadline.unref) deadline.unref()

      pairingTarget = {
        hostKeyZ,
        onConn: async (conn) => {
          if (settled) { try { conn.destroy() } catch {}; return }
          try {
            const r = await c.pairOnConn(conn, { rv: parsed.rv, hostKey: parsed.hostKey, name: parsed.name, label, platform, timeout: 15000 })
            // KEEP the connection: the caller wires the media channel onto this SAME conn (the host's
            // _onconnection serves both PAIR and MEDIA on one connection), so an off-LAN pair does not
            // pay for a SECOND hole-punch - which was timing out and showing a false error, and losing
            // the username claim because the media connection was not up in time.
            if (!settled) { settled = true; clearTimeout(deadline); resolve({ paired: r, conn }) }
            else { try { conn.destroy() } catch {} } // lost the race to another connection
          } catch (e) {
            try { conn.destroy() } catch {} // a failed handshake - drop this conn, the nudge tries again
            // EREFUSED = the host made a decision (wrong token, window shut) - stop, do not retry.
            // EUNREACHABLE/ETIMEDOUT = the punch/handshake dropped - let the nudge land another one.
            if (e.code === 'EREFUSED' && !settled) { settled = true; clearTimeout(deadline); reject(e) }
          }
        }
      }
      nudge() // force discovery now, then keep nudging until a connection lands
    })
    cleanup(false)
    return result
  } catch (e) {
    cleanup(true)
    throw e
  }
}


// Ensure the DEFAULT library is connected, and RETURN its client. Kept under its old name because
// the call sites are everywhere; what changed is that there is no longer a `client` global to read
// afterwards - the value comes back from here, or from mustClient() at the point of use.
async function ensureConnected () {
  const host = loadDefaultHost()
  if (!host) throw new Error('Not paired with a library.')

  const live = clientFor(host.libraryId)
  if (live) return live
  await connectTo(host)
  return mustClient()
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
    // Stamp the first-run time ONCE, so the donation nudge (src/ui, 2 weeks later) has an
    // anchor. Done here, not in DEFAULT_SETTINGS, because a default cannot be "now" - and
    // done on first init rather than first pair so the clock starts when the app is first
    // opened, matching the siblings (they anchor on the profile's createdAt).
    let settings = loadSettings()
    if (!settings.firstRunAt) settings = saveSettings({ firstRunAt: Date.now() })
    const state = {
      deviceKey: b4a.toString(identity.publicKey, 'hex'),
      // The SAME encoding the host's dashboard prints in its device rows (grants
      // are keyed by z32). Settings shows this so an operator deciding which row
      // to revoke can match the phone in their hand to a line on the screen.
      deviceKeyZ32: z32.encode(identity.publicKey),
      // labelFor, not the raw record: a COLD LAUNCH is the one path that used to hand the UI
      // unlabelled names, so the switcher showed "My Library" twice until something else
      // refreshed it (and, since 2026-07-27, showed the host's name rather than your alias).
      host: host ? { ...host, libraryName: labelFor(host.libraryId, host.libraryName) } : null,
      // The full paired-library list (active flagged), so Settings can render the switcher
      // on launch without a second round-trip. Same source as listHosts, so the labels,
      // the aliases and the #suffixes are the ones every other screen uses.
      hosts: listHostsData().hosts,
      settings,
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
      // ARE WE ALREADY CONNECTED? Ask, rather than always answering "no".
      //
      // init() used to hardcode connected:false and leave it entirely to the host:connected
      // EVENT to correct - which is fine on a cold launch, where the connect really has not
      // happened yet. It is wrong on a WEBVIEW RELOAD, and the app reloads its own WebView after
      // any background of 20s (the Vanadium freeze recovery in app/index.tsx). There the worklet
      // never disconnected, so the "connection" is instantaneous: connectTo takes its
      // already-connected fast path and emits host:connected within MILLISECONDS of the UI
      // booting. Win that race and everything is fine; lose it and the event lands in a WebView
      // with no listener yet, and there is never another one - a link that does not drop has no
      // further events to emit. The UI then sits on "PearTune can't reach this library" over a
      // perfectly healthy connection, until you dismiss the app and open it again.
      //
      // CAUGHT ON TIM'S PIXEL, 2026-07-30, which is what turned this from a theory into a fix:
      //   10:13:40.123  [webview] terminated 1 renderer(s) after 215s backgrounded
      //   10:13:40.621  [webview] render process gone -> reload
      //   10:13:41.382  [worklet] link:default {"lib":"jud4pgi4"}   <- already connected
      // and two minutes later the UI still read "Not connected", 0 albums, with the worklet
      // having logged nothing else at all. Read out of the live WebView over CDP, so it is the
      // UI's actual state and not an inference from a screenshot.
      //
      // clientFor rather than defaultConnected(): this reports on the library init is handing
      // over, which is the one the UI is about to render, and it does not depend on
      // defaultLibraryId having been set yet.
      state.connected = !!clientFor(host.libraryId)
      // Connect in the BACKGROUND. The connect can take up to the timeout when the host
      // is unreachable, and blocking init on it would leave a cold launch stuck on
      // "Starting…" for 20s - unbearable, and pointless when the useful surfaces
      // (Downloads, Settings) are all local. host:connected updates the UI when it lands;
      // a failure just leaves us in the normal "not connected" state.
      connectTo(host).catch((e) => {
        // The first connection did not land inside the wait; the swarm membership persists
        // and keeps trying in the background (the host may just be booting, or the wifi not
        // up yet), so nothing to schedule - attach fires host:connected when it lands.
        // WITH THE SWARM'S OWN VIEW, because this line alone cannot tell the three cases
        // apart and they need different fixes: nothing being attempted (`peer:"none"` or
        // attempts capped), every attempt failing (att climbing, conns 0), or rediscovery
        // being a NO-OP because a stale connection is already booked for this peer
        // (`conns:1` with no client - Hyperswarm allows one connection per peer, so the
        // nudge loop below can never land while that entry exists). Tim reports a cold open
        // that will not connect until the app is dismissed and reopened, which is what the
        // third case would look like from the outside; ten scripted relaunches could not
        // reproduce it, so the next real occurrence has to explain itself.
        log('init:connect-failed', { err: e.message, net: networkType, ...swarmDiag(host.hostKey) })
        emit('host:disconnected', { hostKey: host.hostKey })
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

    // DEMO MODE, restored (proposal 2026-07-28-app-review-demo). Only when nothing real is
    // paired: a demo library beside a genuine one is exactly the confusion the proposal rules
    // out, and pairing retires it anyway - this is the belt to that braces, for a demo record
    // that somehow outlived a pair.
    //
    // No assets to resolve and no bytes to copy: the manifest we saved on enable rebuilds the
    // catalog, and the media is already in the audio cache and the art store. So this is a sync
    // disk read plus a hash per track, and the app opens straight into the library.
    const demoRec = loadDemoRecord()
    if (demoRec && !host) {
      activateDemo(demo.buildDemoCatalog(demoRec.manifest, { stats: demoRec.stats || {} }))
      await ensureShim()
      state.demo = true
      state.host = demoHostRow()
      state.hosts = listHostsData().hosts // the one demo row; state.hosts was read before demo mode was on
      state.connected = true // there is nothing to connect TO, and the music plays - so, honestly, yes
      state.shimPort = shimPort
      state.artBase = shim.artBase()
      log('demo:restored', { tracks: demoCatalog.tracks.length })
    } else if (demoRec && host) {
      // A real library exists, so the demo has served its purpose. Reclaim the space.
      retireDemo('paired')
      saveSettings({ demo: false })
    }

    return state
  },

  async pair ({ link, label, userName }) {
    if (!isPairLink(link)) throw new Error('That is not a PearTune pairing code.')

    // OWNER PROMOTION over a live connection (proposal 2026-07-24, P2). If this link is for a
    // host we are ALREADY connected to, a fresh pair handshake is preempted by the live media
    // connection and never reaches the owner window (found in hardware testing). So present the
    // window's one-time code over the EXISTING channel instead: if it is an owner window, the
    // host promotes this device; if not, it is a harmless no-op and we fall through. Only this
    // known-and-connected case takes the shortcut - a new host still pairs normally below.
    try {
      const parsed = parseLink(link)
      const libId = deriveLibraryId(parsed.hostKey)
      const known = loadHostsFile().hosts.find((h) => h.libraryId === libId)
      const c = known && clientFor(libId)
      if (c) {
        // Only attempt promotion when the code SAYS it is an owner code (the host still decides).
        // A normal re-scan of a host we are already on is just a no-op re-activation.
        let promoted = false
        let ownerFailed = false
        if (parsed.owner) {
          const r = await c.ownerClaim({ code: z32.encode(parsed.rv) }).catch(() => null)
          promoted = !!r?.ok
          ownerFailed = !promoted // an owner code that did NOT take - surface it, do not stay normal in silence
          log(promoted ? 'owner:promoted-live' : 'owner:promote-failed', { host: String(known.hostKey).slice(0, 8) })
        }
        // Re-activate + return the known record; no re-pair needed, we are already in.
        saveHostsFile(hostList.addHost(loadHostsFile(), known, Date.now()))
        return { hostKey: known.hostKey, libraryId: known.libraryId, libraryName: known.libraryName, promoted, ownerFailed, alreadyPaired: true }
      }
    } catch { /* fall through to a normal pair - a bad/for-another-host link is handled below */ }

    // The name goes out in deviceHello's EXISTING label field, so this half needs
    // no wire change at all - we were simply hardcoding "Android phone" and giving
    // the operator two identical rows to choose between.
    const name = (label || '').trim() || DEFAULT_DEVICE_NAME

    // Pair OVER THE SWARM (phase 4): the host's topic membership + nudge give pairing the same
    // persistent retry as the media path, so an off-LAN pair keeps punching instead of giving up.
    // `pairConn` is the LIVE connection the pair rode - reused for media below (no second punch).
    const { paired, conn: pairConn } = await pairViaSwarm(link, {
      label: name,
      platform: PLATFORM
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

    // A REAL LIBRARY EXISTS NOW, so the demo retires (proposal: "pairing a real library from
    // inside demo mode should just work, and should retire the demo library from the blend at
    // that point"). Done here, straight after the row is saved and before useLibrary below
    // re-points the default library, so the ~18 MB of bundled music goes back and the switcher
    // can never show a fake library beside a genuine one. A no-op if demo mode was never on.
    if (demoMode() || loadDemoRecord()) {
      retireDemo('paired')
      saveSettings({ demo: false })
    }

    // We are pairing this host, so CANCEL any leave still queued for it. Without this, a
    // removal that never reached an offline host would be retried after the user re-paired
    // and would revoke the grant they just created.
    const pending = loadLeaves()
    if (pending.some((e) => e.hostKey === host.hostKey)) {
      saveLeaves(leaves.dropLeave(pending, host.hostKey))
      log('leaves:cancelled-by-pair', { host: String(host.hostKey).slice(0, 8) })
    }

    // REUSE the pairing connection for the media channel - no second hole-punch, which off-LAN was
    // timing out (a false error while the pair had actually succeeded) and leaving the claim below
    // unsent (device shown unassigned). The host serves both PAIR and MEDIA on one connection, so we
    // just wire media onto this same conn. Fall back to a fresh connect only when there is no conn to
    // reuse (the already-connected short-circuit) or it died in the gap.
    pairingLibId = host.libraryId // attach() must not push identity under pair()'s claim
    try {
      if (pairConn && !pairConn.destroyed) {
        useLibrary(host.libraryId)
        await attach(host, pairConn)
      } else {
        await connectTo(host)
      }
    } finally {
      pairingLibId = null
    }

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
        await mustClient().setIdentity({ deviceName: name, userName: claim })
      } catch (e) {
        log('pair:claim-failed', { err: e?.message })
      }
    }

    return { ...host, shimPort }
  },

  async reconnect () {
    // There is nothing to reconnect TO. Answering "connected" is not a polite fiction here: the
    // library is on the phone and it plays, which is the whole claim the caller is checking.
    if (demoMode()) return { ok: true, connected: true, demo: true, shimPort }
    // Merged mode reads from the POOL and the in-memory index, NOT the single active client -
    // so reconnecting only `client` (ensureConnected) left the blended view exactly as empty as
    // it found it. That is the "ran the Connection check, it reached both, went back to Library
    // and nothing loaded" case: the check dialled every library, reconnect() dialled one socket.
    // Force a rebuild, which reconnects every host and refreshes the blend (and emits
    // merged:updated for the chips). Fall back to the single client for single-host mode.
    if (mergedMode()) {
      await rebuildIndex()
      return { ok: true, connected: mergedConnected.size > 0, merged: true, shimPort }
    }
    await ensureConnected()
    return { ok: true, connected: defaultConnected(), shimPort }
  },

  // The blend answers for ITSELF where it can (Tim, 2026-07-27). `sorts` used to come straight off
  // whichever library happened to be the default, so the Display menu described one host while the
  // list it ordered was the blend: orderings the merged index can do (any field, either direction,
  // Songs included) were hidden because that one server could not do them, and the menu changed
  // meaning when the default library changed. Everything else - the source kind and the server's
  // own name - still belongs to a HOST, not to a blend, so it keeps coming from the default one
  // (the playlist screens label the server with it).
  async stats () {
    if (demoMode()) return demo.demoStats(demoCatalog)
    await ensureConnected()
    const st = await mustClient().stats()
    return mergedMode() ? { ...st, sorts: catalog.MERGED_SORTS } : st
  },

  // The Songs view. Navidrome answers an empty-query search3 with everything,
  // paged, so this is a real list and not the 60-call album walk it used to be.
  async tracks ({ cursor = 0, limit = 100, sort, order, libraryId } = {}) {
    // DEMO MODE, first: the bundled library is served straight out of memory by the very same
    // in-memory helpers the blend uses (worklet/catalog.js), so browsing it needs no host, no
    // connection and no second code path. Same shape in every browse method below.
    if (demoMode()) {
      const page = catalog.serveList(demoCatalog.tracks, { sort: sort || 'title', order, cursor, limit })
      return { ...page, items: page.items.map(withArt) }
    }
    if (mergedMode()) {
      const ix = await ensureIndex()
      // Default to A-Z by title: the merged index CAN sort all songs by title, which a single
      // Subsonic host can't (it has no all-songs sort). Items already carry libraryId + copies.
      const page = catalog.serveList(ix.tracks, { libraryId, sort: sort || 'title', order, cursor, limit })
      return { ...page, items: page.items.map(withArt) }
    }
    await ensureConnected()
    const page = await mustClient().list({ type: 'tracks', cursor, limit, sort, order })
    return { ...page, items: page.items.map(withArt) }
  },

  // Album browsing is the primary way in. A flat list of 1358 tracks is not a
  // music app, and Subsonic has no "all songs" call anyway - so the flat list
  // could only ever show the first page. Albums page properly.
  async albums ({ cursor = 0, limit = 60, sort, order, libraryId } = {}) {
    if (demoMode()) {
      const page = catalog.serveList(demoCatalog.albums, { sort: sort || 'name', order, cursor, limit })
      return { ...page, items: page.items.map(withArt) }
    }
    if (mergedMode()) {
      const ix = await ensureIndex()
      const page = catalog.serveList(ix.albums, { libraryId, sort: sort || 'name', order, cursor, limit })
      return { ...page, items: page.items.map(withArt) }
    }
    await ensureConnected()
    const page = await mustClient().list({ type: 'albums', cursor, limit, sort, order })
    return { ...page, items: page.items.map(withArt) }
  },

  // An album's track LIST isn't in the browse index, so in merged mode a detail read routes to the
  // album's owning host (authoritative order) via its link, then tags the album + enriches each
  // track's copies so streaming can fail over. The UI passes the served album's libraryId back here.
  async album ({ id, libraryId }) {
    if (demoMode()) {
      const a = demoCatalog.albums.find((x) => x.id === id)
      if (!a) return null
      // trackIds -> the track records, in the album order demo.js already sorted them into.
      const tracks = a.trackIds.map((tid) => demoCatalog.tracks.find((t) => t.id === tid)).filter(Boolean)
      return withBigArt({ ...a, tracks })
    }
    const lib = libForEntity(id, libraryId)
    if (mergedMode() && lib) {
      const c = await ensureHostById(lib)
      const a = await c.get({ id, type: 'album' })
      if (!a) return null
      return withBigArt({ ...a, libraryId: lib, tracks: (a.tracks || []).map((t) => enrichCopies({ ...t, libraryId: lib })) })
    }
    await ensureConnected()
    const a = await mustClient().get({ id, type: 'album' })
    return a ? withBigArt(a) : null
  },

  // Artists are the second way in. The host has always been able to list them
  // (`library.list({type:'artists'})`); nothing was asking.
  async artists ({ sort, order, libraryId } = {}) {
    if (demoMode()) {
      const page = catalog.serveList(demoCatalog.artists, { sort: sort || 'name', order })
      return { ...page, items: page.items.map(withArt) }
    }
    if (mergedMode()) {
      const ix = await ensureIndex()
      const page = catalog.serveList(ix.artists, { libraryId, sort: sort || 'name', order })
      return { ...page, items: page.items.map(withArt) }
    }
    await ensureConnected()
    const page = await mustClient().list({ type: 'artists', sort, order })
    return { ...page, items: page.items.map(withArt) }
  },

  // An artist page is a grid of that artist's albums, so its albums need art too. In merged mode the
  // detail routes to the artist's owning host (its full album list); each album carries libraryId so
  // tapping through routes correctly. (A blended cross-host artist page - one host's albums beside
  // another's for the same artist - is a later refinement; phase 1 shows the primary host's.)
  async artist ({ id, libraryId }) {
    if (demoMode()) {
      const a = demoCatalog.artists.find((x) => x.id === id)
      if (!a) return null
      const albums = a.albumIds.map((aid) => demoCatalog.albums.find((x) => x.id === aid)).filter(Boolean)
      // `tracks` is only ever populated for an artist with NO albums, which cannot happen here -
      // but the UI reads the field, so answer it rather than making it guess.
      return { ...withBigArt(a), albums: albums.map(withArt), tracks: [] }
    }
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
    const a = await mustClient().get({ id, type: 'artist' })
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
    if (demoMode()) {
      const a = demoCatalog.artists.find((x) => x.id === id)
      if (!a) return { items: [] }
      return { items: a.trackIds.map((tid) => demoCatalog.tracks.find((t) => t.id === tid)).filter(Boolean).map(withBigArt) }
    }
    // In merged mode read from the artist's owning host (its albums live there); otherwise the
    // single active client. Either way each track is tagged with its libraryId + copies so a
    // mixed-host queue (slice 4) routes every track to a host that has it.
    const lib = libForEntity(id, libraryId)
    let c
    if (mergedMode() && lib) c = await ensureHostById(lib)
    else { c = await ensureConnected() }
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
    if (demoMode()) {
      const page = catalog.serveList(demoCatalog.genres, { sort: sort || 'name', order })
      return { ...page, items: page.items.map(withArt) }
    }
    if (mergedMode()) {
      const ix = await ensureIndex()
      const page = catalog.serveList(ix.genres, { libraryId, sort: sort || 'name', order })
      return { ...page, items: page.items.map(withArt) }
    }
    await ensureConnected()
    const page = await mustClient().list({ type: 'genres', sort, order })
    return { ...page, items: page.items.map(withArt) }
  },

  // A genre page is a grid of its albums (tracks only for a loose-tagged genre with
  // no album of its own - the same fallback artists use). In merged mode the detail routes to the
  // genre's owning host; its albums carry libraryId so tapping through routes correctly.
  async genre ({ id, libraryId }) {
    if (demoMode()) {
      const g = demoCatalog.genres.find((x) => x.id === id)
      if (!g) return null
      const albums = g.albumIds.map((aid) => demoCatalog.albums.find((x) => x.id === aid)).filter(Boolean)
      return { ...withBigArt(g), albums: albums.map(withArt), tracks: [] }
    }
    const lib = libForEntity(id, libraryId)
    let c
    if (mergedMode() && lib) c = await ensureHostById(lib)
    else { c = await ensureConnected() }
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
    if (demoMode()) {
      const g = demoCatalog.genres.find((x) => x.id === id)
      if (!g) return { items: [] }
      return { items: g.trackIds.map((tid) => demoCatalog.tracks.find((t) => t.id === tid)).filter(Boolean).map(withBigArt) }
    }
    const lib = libForEntity(id, libraryId)
    let c
    if (mergedMode() && lib) c = await ensureHostById(lib)
    else { c = await ensureConnected() }
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
  // `libraryId` narrows the shelf to ONE library, the same way every other browse call does. It
  // used to be missing, so picking a library from the header left the "Recently added" shelf
  // showing the whole blend while the grid beneath it showed that one library (Tim, 2026-07-27).
  async recentMerged ({ limit = 12, libraryId } = {}) {
    if (!mergedMode()) return { items: [] }
    const ix = await ensureIndex()
    const page = catalog.serveList(ix.albums, { libraryId, sort: 'added', order: 'desc', cursor: 0, limit })
    return { items: page.items.map(withArt) }
  },

  async search ({ q, libraryId } = {}) {
    if (demoMode()) {
      const r = catalog.searchIndex(demoCatalog, q)
      return {
        tracks: r.tracks.map(withArt),
        albums: r.albums.map(withArt),
        artists: r.artists.map(withArt)
      }
    }
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
    const r = await mustClient().search({ q })
    return {
      ...r,
      albums: (r.albums || []).map(withArt),
      artists: (r.artists || []).map(withArt)
    }
  },

  // --- demo mode (proposal 2026-07-28-app-review-demo) ------------------------
  //
  // Turn the bundled library on. The SHELL resolves the assets and passes their local paths,
  // because only it can: the audio and the cover are Expo assets, copied out of the app bundle
  // under hashed names that no path in the worklet could guess.
  //
  //   manifest - assets/demo-music/manifest.json, already parsed (Metro inlines JSON)
  //   files    - { '01 ....mp3': '/local/path', ... }, one per manifest track
  //   cover    - the local path of manifest.cover
  //
  // Idempotent: enabling twice rebuilds the catalog and re-checks the install, which is a
  // handful of `cache.has` calls once the media is down. Nothing here touches hosts.json, the
  // identity keypair, the grant store or a pairing window - a demo library is not a pairing.
  async enableDemo ({ manifest, files = {}, cover = null } = {}) {
    if (!manifest || !Array.isArray(manifest.tracks) || !manifest.tracks.length) {
      throw new Error('The demo library is missing from this build.')
    }
    const stats = demo.statDemoFiles(files)
    const built = demo.buildDemoCatalog(manifest, { stats })
    activateDemo(built)

    // The shim FIRST, exactly as init does for a real library: it owns the loopback port every
    // play URL carries, and the install below is pointless without something to serve it.
    await ensureShim()
    const r = await demo.installDemoMedia({ catalog: built, files, cover, cache: audioCache, artStore, log })
    // Persist the manifest (with the sizes we just measured) so a relaunch rebuilds the catalog
    // with no assets to resolve and no bytes to copy.
    saveDemoRecord({ manifest, stats })
    saveSettings({ demo: true })
    log('demo:enabled', { tracks: built.tracks.length, installed: r.installed, skipped: r.skipped, failed: r.failed, art: r.art })

    return {
      ok: true,
      demo: true,
      host: demoHostRow(),
      connected: true,
      shimPort,
      artBase: shim.artBase(),
      tracks: built.tracks.length,
      installed: r.installed,
      failed: r.failed
    }
  },

  // Leave demo mode by hand (Settings). Pairing a real library retires it automatically - see
  // the retireDemo call in pair() - so this is for someone who simply wants the space back.
  async disableDemo () {
    const r = retireDemo('disabled')
    saveSettings({ demo: false })
    return r
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
    // The pool STAYS CONNECTED (P1, 2026-07-26). It used to be torn down here on the grounds that
    // nobody reads the blend outside merged mode - but focusing one library is a VIEW, not an
    // unpairing: the other libraries still hold queued writes for their own outboxes, still hold
    // other copies of tracks in the queue, and are one tap from being read again. Dropping them
    // meant that tap paid for a fresh hole-punch, and it is also what let a library stay dark
    // (the nudge loop stopped with it). The connection watchdog would re-dial them within 30s
    // anyway, so tearing down here would now be churn that contradicts the policy.
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
    // Read the live identity from an ALREADY-CONNECTED host, and NEVER dial. identity() used to
    // `await ensureConnected()`, so a down ACTIVE host blocked the name/confirm fields for the whole
    // 45s connect budget - Settings sat blank until the dial finally failed (Tim, 2026-07-22, off-LAN
    // with the active host down). Now the local names return immediately; loadIdentity() re-fires on
    // host:connected and picks up the remote data then.
    //
    // Source: the active client when it's up, else (merged mode) any connected pool host - the device
    // identity is one keypair shared across every host, so a down active host must not starve the
    // fields when another host IS connected (fix (b) in the report).
    let c = defaultConnected() ? clientFor(defaultLibraryId) : null
    if (!c && mergedMode()) {
      const lib = [...connectedLibs()][0]
      if (lib) c = clientFor(lib)
    }
    let remote = null
    if (c) {
      try {
        remote = await c.getIdentity()
      } catch {
        // The connection dropped mid-read, or an old host. Local names are still the truth about
        // what we last asked for.
      }
    }
    // Live library-name update: the operator can rename the library on the dashboard, and identity.get
    // carries the CURRENT name. If it changed, persist it to the host record and tell the UI, so the
    // header + switcher + merged chips update without a re-pair. Guard on `c === client`: `remote` may
    // have come from a POOL host (when the active host is down), whose name belongs to a DIFFERENT
    // record - renaming the active host to it would be wrong. A pool host's own name is synced by the
    // merged block just below.
    if (c === defaultClient() && remote?.libraryName) {
      const active = loadDefaultHost()
      if (active && active.libraryName !== remote.libraryName) {
        saveHostsFile(hostList.renameHost(loadHostsFile(), active.hostKey, remote.libraryName))
        emit('host:renamed', { hostKey: active.hostKey, libraryName: labelFor(active.libraryId, remote.libraryName), hostName: remote.libraryName })
      }
    }
    // Extend that live rename to the OTHER hosts in a blend. This method rides loadIdentity(), which
    // fires on EVERY host:connected - but a complete-blend reconnect reloads browse WITHOUT a rebuild,
    // so syncHostNames (which only rides rebuildIndex) never runs and a non-active host's rename stays
    // stale in the chip. Sync the connected pool hosts here too, on the same trigger the active host
    // uses. Fire-and-forget so identity() stays fast; syncHostNames emits host:renamed per change.
    if (mergedMode()) {
      const activeKey = loadDefaultHost()?.hostKey
      const others = loadHostsFile().hosts.filter((h) => h.hostKey !== activeKey && clientFor(h.libraryId))
      if (others.length) syncHostNames(others).catch(() => {})
    }
    // Persist the confirmation state we just learned, so it survives OFFLINE the same way the names do:
    // a confirmed device must keep reading "confirmed" when it can't reach the host, not fall back to a
    // scary "waiting / only a label" (Tim, 2026-07-22). Only when we actually reached a host this call.
    if (remote) saveSettings({ confirmed: !!remote.user?.confirmed, belongsTo: remote.belongsTo || '' })
    return {
      deviceName: remote?.deviceName || local.deviceName || '',
      userName: remote?.user?.name || local.userName || '',
      // Fall back to the last-known values offline (see saveSettings above).
      confirmed: remote ? !!remote.user?.confirmed : !!local.confirmed,
      belongsTo: remote ? (remote.belongsTo || null) : (local.belongsTo || null),
      libraryName: remote?.libraryName || null,
      // A guest pass's expiry (null = permanent / offline / old host), so the UI can show
      // a countdown banner. Only meaningful when we actually reached the host this call.
      expiresAt: remote?.expiresAt ?? null,
      // Is this device the OWNER of the ACTIVE library (proposal 2026-07-24, P2)? Only when
      // we actually reached the host this call - never assumed offline, so a lost connection
      // can't leave a stale owner surface up. Off `remote.owner` (the host's grant scope).
      owner: !!remote?.owner,
      // `supported` distinguishes an OLD host (reached, but no identity method) from OFFLINE (never
      // reached). Only false when we HAD a connection and it didn't answer - so a plain offline phone
      // never shows the misleading "your server is running an older PearTune" message.
      supported: remote !== null || !c
    }
  },

  async setIdentity ({ deviceName, userName }) {
    await ensureConnected()
    const r = await mustClient().setIdentity({ deviceName, userName })
    saveSettings({
      deviceName: r?.deviceName || deviceName || '',
      userName: r?.user?.name || userName || ''
    })
    // Every OTHER paired host gets it too - saveSettings first, so what they receive is
    // what we just committed locally (and what a later reconnect will re-send).
    fanOutIdentity().catch(() => {})
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
    try { await ensureConnected(); await mustClient().setAvatar({ avatar: a }) } catch {}
    // The pool hosts too. Note this sends an EMPTY avatar as well, unlike the reconnect
    // sync: clearing your photo is a deliberate act and must reach every host, whereas a
    // reconnect has no business deleting one.
    await Promise.allSettled([...links.keys()].map((libId) => {
      const c = clientFor(libId)
      return c ? c.setAvatar({ avatar: a }) : null
    }))
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
    // Looked up whether or not we hold the token, because a device that does NOT hold it still
    // has something to do here - see the reconcile below.
    const tgt = sessionTarget()
    if (tgt && tgt.c && sessionSupportedFor(tgt.lib) && snapshot && sessionActive) {
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
    } else if (tgt && tgt.c && sessionSupportedFor(tgt.lib) && snapshot && snapshot.playing) {
      // PLAYING WITHOUT THE TOKEN - reconcile (proposal 2026-07-30-one-device-plays).
      //
      // sessionActivate is fired once, on the transition into playing, and before this a failed
      // claim was never retried: a phone that was offline at that instant (playing a download)
      // played with no token forever, and since the block above only ran for a HOLDER it never
      // spoke to the host about the session again. Measured 2026-07-30: two of Tim's phones
      // playing different tracks for 70s, the offline one still going after it reconnected and
      // could see on its own screen that the other was the active player.
      //
      // Riding the heartbeat means the fix is "the moment you are back on the wire", with no new
      // timer and no dialing (sessionTarget is sync). Only while PLAYING - a paused device must
      // not fight for a token it is not using.
      lostSession = await reconcileSession(tgt)
    }

    // TELL THE OWNING LIBRARY WHAT WE ARE PLAYING (proposal 2026-07-28-nowplaying-from-the-phone).
    // Its dashboard is the one an operator opens - "is anyone listening to my music right now?" -
    // and until now only the elected SESSION HOME could answer, which is a different host and often
    // not the one serving a note. This rides the same ~4s heartbeat, needs no claim, and the host
    // EXPIRES it, so stopping is simply us going quiet. Independent of the session block above:
    // it fires whether or not we hold the token.
    reportNowPlaying(snapshot).catch(() => {})

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
            // Route by the track's OWNING library, not the session client. Since the token moved to
            // the elected host, `c` is no longer the host that holds this track in single mode
            // either - asking it would quietly return 0 and start the track from the top.
            const rc = clientFor(trackLib.get(cur.id)) || defaultClient() || c
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
    // The demo library syncs nothing anywhere, by design (proposal: "no revoke, no requests, no
    // favourites syncing anywhere"). supported:false is the same answer a too-old host gives, and
    // the UI already knows to hide the hearts on it rather than offer a control that cannot work.
    if (demoMode()) return { track: [], album: [], artist: [], supported: false }
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
      const g = await mustClient().favList()
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
    // Nowhere to write it: the demo library has no host, and queuing it to an outbox would
    // leave a write on disk aimed at a library that will never exist.
    if (demoMode()) return { ok: true }
    // WHEN WE ACTUALLY LISTENED, stamped here rather than on arrival. An offline write sits in
    // the outbox until the next reconnect, and the host used to date it from the moment it
    // landed - which put a returning phone's stale positions in FRONT of the phone playing right
    // now, and made "Continue listening" flip (proposal 2026-07-30-one-device-plays). Riding in
    // the params means the outbox carries it for free; an old host just ignores it.
    const playedAt = Date.now()
    if (mergedMode()) {
      // Route the resume to the track's OWNING host; queue to that host's outbox if it's unreachable,
      // so it syncs when the host reconnects (coalesce keeps only the latest position per track).
      const lib = favHost('track', trackId)
      const c = lib && clientFor(lib)
      if (c) { try { await c.resumeSet({ trackId, positionMs, durationMs, playedAt }) } catch { enqueueFor(lib, 'resume.set', { trackId, positionMs, durationMs, playedAt }) } }
      else if (lib) enqueueFor(lib, 'resume.set', { trackId, positionMs, durationMs, playedAt })
      return { ok: true }
    }
    // When connected, write straight through; when not, queue immediately rather than
    // block this frequent call on a doomed connect. The flush rides the next reconnect.
    if (defaultConnected()) {
      try { await mustClient().resumeSet({ trackId, positionMs, durationMs, playedAt }) } catch { enqueue('resume.set', { trackId, positionMs, durationMs, playedAt }) }
    } else {
      enqueue('resume.set', { trackId, positionMs, durationMs, playedAt })
    }
    return { ok: true }
  },

  async resumeGet ({ trackId }) {
    if (demoMode()) return { positionMs: 0 }
    if (mergedMode()) {
      const c = trackClient(trackId)
      if (c) { try { return await c.resumeGet({ trackId }) } catch {} }
      return { positionMs: 0 }
    }
    try {
      await ensureConnected()
      return await mustClient().resumeGet({ trackId })
    } catch {
      return { positionMs: 0 }
    }
  },

  // The "continue listening" candidate: the most recent resume, RESOLVED to a
  // renderable track (title, artist, art) so the launch card can show it. Null when
  // there is nothing to continue, offline, or on an old host.
  async resumeLatest () {
    if (demoMode()) return null // nothing is stored, so there is no 'continue listening'
    if (mergedMode()) {
      // The globally-most-recent resume across hosts: each host's latest, then pick the newest by
      // updatedAt, and resolve the track from that host.
      const libs = [...connectedLibs()]
      const settled = await Promise.allSettled(libs.map(async (lib) => {
        const c = clientFor(lib)
        if (!c) return null
        const r = await c.resumeLatest()
        return r && r.trackId ? { ...r, lib } : null
      }))
      const cands = settled.filter((x) => x.status === 'fulfilled' && x.value).map((x) => x.value)
      if (!cands.length) return null
      // By playedAt where the host offers it, so a host we were offline from cannot win the
      // blend just because its outbox drained a second ago. An old host sends only updatedAt.
      const when = (r) => Number(r.playedAt) || Number(r.updatedAt) || 0
      cands.sort((a, b) => when(b) - when(a))
      const best = cands[0]
      const c = clientFor(best.lib)
      const t = c && await c.get({ id: best.trackId, type: 'track' }).catch(() => null)
      if (!t) return null
      return { track: withArt({ ...t, libraryId: best.lib }), positionMs: best.positionMs, durationMs: best.durationMs }
    }
    try {
      await ensureConnected()
      const r = await mustClient().resumeLatest()
      if (!r?.trackId) return null
      const t = await mustClient().get({ id: r.trackId, type: 'track' }).catch(() => null)
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
    if (demoMode()) return { ok: true } // see resumeSave
    if (mergedMode()) {
      // Count the play on the track's OWNING host; queue to that host's outbox if unreachable, so the
      // play isn't lost (each queued bump is a real play - counts accumulate).
      const lib = favHost('track', trackId)
      const c = lib && clientFor(lib)
      if (c) { try { await c.countBump({ trackId }) } catch { enqueueFor(lib, 'count.bump', { trackId }) } }
      else if (lib) enqueueFor(lib, 'count.bump', { trackId })
      return { ok: true }
    }
    if (defaultConnected()) {
      try { await mustClient().countBump({ trackId }) } catch { enqueue('count.bump', { trackId }) }
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
        const c = clientFor(lib)
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
        const c = clientFor(it.lib)
        if (!c) continue
        const t = await c.get({ id: it.trackId, type: 'track' }).catch(() => null)
        if (t) out.push({ ...withArt({ ...t, libraryId: it.lib }), playCount: it.count })
      }
      return { items: out }
    }
    try {
      await ensureConnected()
      const { items } = await mustClient().countTop({ limit })
      const out = []
      for (const it of items) {
        const t = await mustClient().get({ id: it.trackId, type: 'track' }).catch(() => null)
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
    if (demoMode()) return { ok: false, supported: false } // see favorites
    const want = on !== false
    if (mergedMode()) {
      // Route to the host that OWNS this item; flip the blended cache optimistically so the heart
      // reacts instantly. If the owning host is unreachable, queue the write to its outbox so it syncs
      // on reconnect (LWW - coalesce keeps only the latest on/off per item).
      applyMergedFav(kind, id, want)
      const lib = favHost(kind, id)
      const c = lib && clientFor(lib)
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
    if (defaultConnected()) {
      try {
        const r = await mustClient().favSet({ kind, id, on: want })
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
    if (demoMode()) return { tracks: [], albums: [], artists: [] }
    if (mergedMode()) {
      // Union across hosts, then resolve each favorite from the SAME host that has it (src map), so a
      // track favorited on the Mac resolves off the Mac. Skips anything unresolvable, like single-host.
      const { grouped, src } = await unionFavs()
      saveMergedFavCache(grouped)
      const resolve = async (ids, type) => {
        const out = []
        for (const id of ids) {
          const lib = src.get(id)
          const c = lib && clientFor(lib)
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
    const g = await mustClient().favList()
    const grouped = { track: g.track || [], album: g.album || [], artist: g.artist || [] }
    saveFavCache(grouped)
    const resolve = async (ids, type) => {
      const out = []
      for (const id of ids) {
        const it = await mustClient().get({ id, type }).catch(() => null)
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
    // Playlists live on the host (host-as-hub), so a demo library cannot have any - and
    // supported:false is what tells the UI to hide the section instead of showing an empty
    // list with a New button that could only fail.
    if (demoMode()) return { items: [], supported: false }
    try {
      await ensureConnected()
      const { items } = await mustClient().playlistList()
      savePlaylistCache(items)
      return { items, supported: true }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') return { items: [], supported: false }
      return { items: loadPlaylistCache(), supported: true, offline: true }
    }
  },

  // --- music requests (proposal 2026-07-24, P1) -----------------------------
  // File a request. In a BLENDED library nobody has the music (that is WHY you are
  // requesting it), so it goes to EVERY connected host - any of their owners might add
  // it (Tim, 2026-07-24). Single-host mode sends to the one active host. supported:false
  // only when NO reachable host understands requests (all old), so the affordance hides
  // just like favorites/playlists on an old host.
  async requestAdd ({ kind, name, artist, album, mbid }) {
    const params = { kind, name, artist, album, mbid }
    if (mergedMode()) {
      const libs = [...connectedLibs()]
      if (!libs.length) return { ok: false, error: 'not connected to any library' }
      const settled = await Promise.allSettled(libs.map((lib) => {
        const c = clientFor(lib)
        return c ? c.requestAdd(params) : Promise.reject(new Error('offline'))
      }))
      let ok = 0
      let anySupported = false
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value?.ok) { ok++; anySupported = true }
        else if (r.reason?.code !== 'ENOMETHOD' && r.status === 'rejected') { /* transport error, not "old host" */ anySupported = true }
      }
      if (ok > 0) return { ok: true, supported: true, sent: ok }
      // Nobody accepted. If every reachable host answered ENOMETHOD it is a support gap;
      // otherwise it was a transport failure worth reporting as such.
      return anySupported ? { ok: false, error: 'could not reach a library to request from' } : { ok: false, supported: false }
    }
    try {
      await ensureConnected()
      const r = await mustClient().requestAdd(params)
      return { ...r, supported: true }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') return { ok: false, supported: false }
      return { ok: false, error: e?.message || 'could not send the request' }
    }
  },

  // This device's own requests + their status. In merged mode, UNION across every connected
  // host and COLLAPSE identical asks to one row carrying the best status (added > pending >
  // declined - if any host added it, the music is coming) + which libraries it went to.
  // Single-host = just the active host's. Empty (not shown) on an all-old set of hosts.
  async requestList () {
    // Requests go TO an operator, and a demo library has none. supported:false hides the
    // 'ask for this music' affordance rather than offering a message with no recipient.
    if (demoMode()) return { requests: [], supported: false }
    if (mergedMode()) {
      const libs = [...connectedLibs()]
      const names = hostList.libraryLabels(loadHostsFile().hosts)
      const settled = await Promise.allSettled(libs.map((lib) => {
        const c = clientFor(lib)
        return c ? c.requestList().then((v) => ({ lib, requests: v.requests || [] })) : Promise.reject(new Error('offline'))
      }))
      const tagged = []
      let anySupported = false
      for (const r of settled) {
        if (r.status !== 'fulfilled') continue
        anySupported = true
        for (const req of r.value.requests) tagged.push({ ...req, libraryId: r.value.lib, libraryName: names.get(r.value.lib) || null })
      }
      return { requests: merge.collapseRequests(tagged), supported: anySupported }
    }
    try {
      await ensureConnected()
      const { requests } = await mustClient().requestList()
      // Give single-host rows a `refs` too, so the app's REMOVE path is uniform with the
      // merged one (delete every (libraryId,id) the ask lives on).
      const refs = (r) => [{ libraryId: defaultLibraryId, id: r.id }]
      return { requests: (requests || []).map((r) => ({ ...r, refs: refs(r) })), supported: true }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') return { requests: [], supported: false }
      return { requests: [], offline: true }
    }
  },

  // --- owner maintenance (proposal 2026-07-24, P2) --------------------------
  // Target the ACTIVE host - you are an owner OF a specific library, and identity().owner
  // reflects the active one, so the owner surface manages whatever library you are in.
  // supported:false = an old host (ENOMETHOD); forbidden:true = this device is not an owner
  // of the active library (the host said so - the source of truth, not the local flag).
  // The libraries this device OWNS and can currently reach - what the Manage picker lists so an
  // owner of several can manage each (Tim: Manage only showed the last-paired one). Queries
  // identity on each connected client; a library you own but are offline to can't be managed, so
  // it is omitted. The active library is flagged so the picker can default to it.
  async ownedLibraries () {
    // Drop the live client - the list crosses the IPC boundary as JSON.
    return { libraries: (await ownedLibraryList()).map(({ client: _c, ...l }) => l) }
  },

  // Every owner.* below takes an optional libraryId so Manage can act on a chosen owned library;
  // omitted, it falls back to the active one (ownerClient handles both).
  async ownerDevices ({ libraryId } = {}) {
    try {
      const { devices } = await (await ownerClient(libraryId)).ownerDevices()
      return { devices: devices || [], supported: true }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') return { devices: [], supported: false }
      if (e?.code === 'EFORBIDDEN') return { devices: [], forbidden: true }
      return { devices: [], offline: true }
    }
  },

  // --- Home Assistant speakers (proposal 2026-08-01) ------------------------
  //
  // Same degradation contract as the owner.* methods above, and for the same reason:
  // an old host answers ENOMETHOD and a non-owner grant answers EFORBIDDEN, and the UI
  // must treat BOTH as "there are no speakers here" rather than as an error worth
  // showing. `enabled: false` is the third ordinary case - the host is new enough and
  // this device is an owner, but nobody has set Home Assistant up.
  //
  // Speakers belong to a LIBRARY (the host that talks to Home Assistant), so these
  // target the active host unless a libraryId says otherwise, exactly like owner.*.
  async speakerList ({ libraryId } = {}) {
    try {
      const r = await (await ownerClient(libraryId)).speakerList()
      return { speakers: r?.speakers || [], active: r?.active || [], enabled: !!r?.enabled, supported: true }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') return { speakers: [], active: [], enabled: false, supported: false }
      if (e?.code === 'EFORBIDDEN') return { speakers: [], active: [], enabled: false, forbidden: true }
      return { speakers: [], active: [], enabled: false, offline: true }
    }
  },

  // ONE track. The speaker has no queue of its own (no MEDIA_ENQUEUE on either the
  // ESPHome or the Cast platform), so the app stays the queue and sends the next track
  // when the host pushes `speaker:ended`.
  async speakerPlay ({ libraryId, entityId, trackId }) {
    try {
      await (await ownerClient(libraryId)).speakerPlay({ entityId, trackId })
      castingOn = true
      castingPaused = false
      return { ok: true }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') return { ok: false, supported: false }
      return { ok: false, error: e?.message || 'could not play on that speaker' }
    }
  },

  async speakerStop ({ libraryId, entityId }) {
    try {
      await (await ownerClient(libraryId)).speakerStop({ entityId })
      castingOn = false
      castingPaused = false
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message || 'could not stop that speaker' }
    }
  },

  // Pause and resume the SPEAKER, so the player's play/pause button has something to
  // drive while casting instead of falling through to the phone.
  async speakerPause ({ libraryId, entityId }) {
    try {
      await (await ownerClient(libraryId)).speakerPause({ entityId })
      castingPaused = true
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message || 'could not pause that speaker' }
    }
  },

  async speakerResume ({ libraryId, entityId }) {
    try {
      await (await ownerClient(libraryId)).speakerResume({ entityId })
      castingPaused = false
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message || 'could not resume that speaker' }
    }
  },

  async speakerVolume ({ libraryId, entityId, level }) {
    try {
      await (await ownerClient(libraryId)).speakerVolume({ entityId, level })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message || 'could not change the volume' }
    }
  },

  async ownerRevoke ({ libraryId, deviceKey }) {
    try {
      const r = await (await ownerClient(libraryId)).ownerRevoke({ deviceKey })
      return { ...r, supported: true }
    } catch (e) {
      if (e?.code === 'ENOMETHOD') return { ok: false, supported: false }
      if (e?.code === 'EFORBIDDEN') return { ok: false, error: e.message || 'not allowed' }
      return { ok: false, error: e?.message || 'could not revoke' }
    }
  },

  // P2b: open a pairing window on a host remotely; the owner shares the link so a device can pair
  // while they are away. Returns the link (a normal window - never an owner one).
  async ownerPairStart ({ libraryId, expiresMs } = {}) {
    try { return { ...(await (await ownerClient(libraryId)).ownerPairStart({ expiresMs })), ok: true } } catch (e) { return { ok: false, error: e?.message || 'could not open a pairing window' } }
  },
  async ownerPairStop ({ libraryId } = {}) {
    try { return await (await ownerClient(libraryId)).ownerPairStop() } catch { return { ok: false } }
  },
  async ownerPairState ({ libraryId } = {}) {
    try { return await (await ownerClient(libraryId)).ownerPairState() } catch { return { pairing: false } }
  },

  // The full request queue for the owner to work from the app - AGGREGATED across every library
  // this device owns and can reach, not just the one Manage's picker has selected (Tim,
  // 2026-07-25). A request from a blended library is filed with EVERY connected host, so a
  // per-library queue showed the same ask once per library and, worse, the You-tab badge (which
  // asks with no libraryId) only ever counted the ACTIVE library - pending work on a second owned
  // library was silent. Mirrors the requester side exactly: union, tag with the library, fold
  // identical asks to one row. `pendingWins` because this view is a to-do list - see merge.js.
  //
  // `libraryId` narrows it back to one library (kept for a caller that wants a single host's
  // queue); omitted = the aggregate, which is what Manage and the badge use.
  async ownerRequests ({ libraryId } = {}) {
    if (libraryId) {
      try { return { requests: (await (await ownerClient(libraryId)).ownerRequests()).requests || [], supported: true } } catch (e) {
        if (e?.code === 'ENOMETHOD') return { requests: [], supported: false }
        return { requests: [], offline: true }
      }
    }
    const libs = await ownedLibraryList()
    if (!libs.length) return { requests: [], offline: true }
    const settled = await Promise.allSettled(libs.map((l) => l.client.ownerRequests().then((v) => ({ l, requests: v.requests || [] }))))
    const tagged = []
    let anySupported = false
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue
      anySupported = true
      for (const req of r.value.requests) tagged.push({ ...req, libraryId: r.value.l.libraryId, libraryName: labelFor(r.value.l.libraryId, r.value.l.libraryName) })
    }
    if (!anySupported) return { requests: [], supported: false }
    return { requests: merge.collapseRequests(tagged, { pendingWins: true }), supported: true, libraries: libs.length }
  },

  // Resolve an ask. `refs` is every per-host (libraryId, id, status) the collapsed row covers, so
  // one tap clears the ask on ALL the owner's libraries rather than leaving copies pending on the
  // others. Only the PENDING copies are touched: an "added" fan-out must never rewrite a row some
  // other owner already declined, and re-resolving a settled row would move its resolvedAt for no
  // reason. Best-effort - a library that is offline or fails keeps its copy pending, which is
  // exactly what the next queue read shows (the row stays up carrying only what is left).
  async ownerResolveRequest ({ libraryId, id, status, refs }) {
    const list = merge.resolveTargets({ refs, id, libraryId }, defaultLibraryId)
    if (!list.length) return { ok: false, error: 'nothing to resolve' }
    const settled = await Promise.allSettled(list.map((ref) => (async () => {
      const c = await ownerClient(ref.libraryId)
      return await c.ownerResolveRequest({ id: ref.id, status })
    })()))
    const done = settled.filter((r) => r.status === 'fulfilled' && r.value?.ok !== false).length
    if (!done) {
      const err = settled.find((r) => r.status === 'rejected')?.reason
      return { ok: false, error: err?.message || 'could not resolve' }
    }
    return { ok: true, resolved: done, total: list.length, partial: done < list.length }
  },

  // Remove the caller's OWN request. `refs` is every per-host (libraryId, id) the collapsed
  // row covers (one in single-host, N in a blend), so REMOVE clears it everywhere it lives.
  // The host refuses to delete a request that is not yours (media.js checks ownership).
  async requestDelete ({ refs }) {
    const list = Array.isArray(refs) ? refs.filter((x) => x && x.libraryId && x.id) : []
    if (!list.length) return { ok: false }
    const settled = await Promise.allSettled(list.map(({ libraryId, id }) => {
      const c = clientFor(libraryId)
      return c ? c.requestDelete({ id }) : Promise.reject(new Error('offline'))
    }))
    const ok = settled.some((r) => r.status === 'fulfilled' && r.value?.ok)
    return { ok }
  },

  // One playlist. We return BOTH the raw ordered trackIds and the resolved tracks:
  // a track that no longer resolves (source changed, file gone) is left out of the
  // rendered list, but its id STAYS in trackIds and each resolved track carries its raw
  // index `_i`. That is what lets the app reorder/remove by editing the raw id list -
  // so an edit never silently drops a track that merely failed to resolve this time.
  async playlistDetail ({ id }) {
    await ensureConnected()
    const pl = await mustClient().playlistGet({ id })
    const ids = pl.trackIds || []
    const tracks = []
    for (let i = 0; i < ids.length; i++) {
      const t = await mustClient().get({ id: ids[i], type: 'track' }).catch(() => null)
      // `_i` is the raw slot (reassigned when the app reorders); `_k` is a STABLE
      // per-row identity for React keys, so a drag animates a move rather than
      // remounting rows (a track id can repeat within a playlist, so it cannot key).
      if (t) tracks.push({ ...withArt(t), _i: i, _k: tracks.length })
    }
    return { id: pl.id, name: pl.name, trackIds: ids, tracks }
  },

  async createPlaylist ({ name }) {
    await ensureConnected()
    return await mustClient().playlistCreate({ name })
  },

  async renamePlaylist ({ id, name }) {
    await ensureConnected()
    return await mustClient().playlistRename({ id, name })
  },

  async deletePlaylist ({ id }) {
    await ensureConnected()
    await mustClient().playlistDelete({ id })
    return { ok: true }
  },

  // Append tracks. The UI resolves an album/artist to its trackIds first (via the same
  // tracksFor it uses for Play/Queue), so this just forwards the ids.
  async addToPlaylist ({ id, trackIds }) {
    await ensureConnected()
    return await mustClient().playlistAdd({ id, trackIds })
  },

  // Replace the whole order - the app's single write path for both remove and reorder.
  async setPlaylistTracks ({ id, trackIds }) {
    await ensureConnected()
    return await mustClient().playlistSetTracks({ id, trackIds })
  },

  // The SERVER's own playlists (v2), read-only. These come from Navidrome/Jellyfin via
  // the normal library.list/get - no host state involved - and the app shows them beside
  // our host-stored ones and can play them, but not edit them (DECISIONS: no write-back).
  // A folder source (or an old/limited server) simply returns none.
  async serverPlaylists () {
    try {
      await ensureConnected()
      const { items } = await mustClient().list({ type: 'playlists' })
      return { items: items || [] }
    } catch {
      return { items: [] }
    }
  },

  async serverPlaylistDetail ({ id }) {
    await ensureConnected()
    const pl = await mustClient().get({ id, type: 'playlist' })
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
      // A network switch (wifi<->cellular) drops the swarm's sockets; the prior DHT announce/
      // lookup is on the old network too. Force a fresh discovery so the active host is redialed
      // on the new network promptly, rather than waiting out Hyperswarm's own refresh cadence
      // (PearCircle does the same flush on network:changed). No-op with no swarm / when off.
      if (t !== 'none') { const h = loadDefaultHost(); if (h) nudge(h.libraryId) }
    }
    return { networkType }
  },

  // Which library the person has picked in the switcher. '_all' (or nothing) means the blend, and
  // routing goes back to preferring the primary copy. See `preferredLib`.
  async setLibraryFilter ({ libraryId } = {}) {
    preferredLib = libraryId && libraryId !== '_all' ? libraryId : null
    log('filter:library', { lib: preferredLib ? String(preferredLib).slice(0, 8) : 'all' })
    return { ok: true }
  },

  // The URL the RN player hands to ExoPlayer. The audio never touches RN: the
  // player pulls it from the worklet's loopback server, which pulls it over P2P.
  // Where cast mode points the player's queue instead of at real audio (see the note in
  // worklet/shim.js). Needs the shim up, because the URL carries its port.
  async silenceUrl () {
    await ensureShim()
    return { url: 'http://127.0.0.1:' + shimPort + '/silence.wav', port: shimPort }
  },

  async urlFor ({ trackId, libraryId, copies }) {
    await ensureShim()
    // DEMO MODE needs no serving code of its own: the bundled tracks were installed as PINNED
    // audio-cache entries, so the shim's ordinary cache-hit path already serves them off disk -
    // ranges, seeking, backpressure and all. Nothing to route, no host to revive, and no lease to
    // check (there is no host that could have authorized us; see ensureShim's leaseOk).
    if (demoMode()) return { url: shim.urlFor(trackId), port: shimPort }
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
    return { bytes: audioCache.totalBytes(), count: audioCache.count(), cap: audioCache.cap, ...artStats() }
  },

  clearCache () {
    audioCache.clear()
    log('cache:cleared')
    return { bytes: 0, count: 0, cap: audioCache.cap }
  },

  // Throw away the stored artwork so it refetches at whatever the server now has (decision 1
  // of proposal 2026-07-29-persist-album-art). Covers are kept until their library is removed,
  // which is predictable and never re-downloads on a timer - but a server CAN change an album's
  // art without changing its coverId, and then the old image would be right forever. This is
  // the escape hatch for that, and it is the whole store rather than one album because "which
  // cover is wrong" is not something the app can know.
  //
  // Only art. The audio cache is untouched, so downloads still play offline.
  refreshArtwork () {
    const before = artStore.count()
    artStore.clear()
    // Emptying the store was never enough on its own, and this is the half that was missing. Two
    // caches sit in front of it - the shim's in-memory map, and the WEBVIEW'S OWN http cache,
    // which answers a cover it has already rendered without the request reaching the shim at all.
    // Measured on the TCL 2026-07-30: 273 covers dropped, then browsing the same grid re-fetched
    // exactly none, so a wrong cover stayed wrong and "Using" sat at 0 until the app was
    // restarted. refreshArt() clears the map and mints a new artBase, which the UI adopts - a URL
    // the WebView has never seen is the only thing its cache cannot answer. See worklet/shim.js.
    // Returned rather than pushed: init()'s `state` is a local, and the UI is the only holder of
    // artBase that matters (it composes every cover URL from it).
    const artBase = shim ? shim.refreshArt() : null
    log('art:refreshed', { dropped: before })
    return { ok: true, dropped: before, artBase }
  },

  setCacheCap ({ bytes }) {
    const cap = Math.max(0, Number(bytes) || 0)
    const s = loadSettings()
    s.cacheCap = cap
    saveSettings(s)
    audioCache.setCap(cap) // may evict immediately if the new cap is smaller
    return { bytes: audioCache.totalBytes(), count: audioCache.count(), cap, ...artStats() }
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
    const album = await mustClient().get({ id: albumId, type: 'album' })
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
          const sink = audioCache.createSink(t.id, { mime, size: t.size, library: defaultLibraryId || null })
          await mustClient().streamTo({ trackId: t.id }, (chunk) => sink.write(chunk))
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
      // Already on disk from BROWSING? Just protect it from eviction rather than downloading it
      // again to earn its pin (proposal 2026-07-29-persist-album-art).
      if (artStore.has(coverId, DEFAULT_ART_SIZE)) { artStore.setPinned(coverId, true); continue }
      try {
        // Store at the size the Downloads views request. Pinned at write time so the LRU can
        // never take a downloaded album's cover - an offline download whose art was evicted
        // renders as a placeholder, which defeats the point of downloading it.
        const buf = await mustClient().art({ coverId, size: DEFAULT_ART_SIZE })
        artStore.put(coverId, buf, { size: DEFAULT_ART_SIZE, library: defaultLibraryId, pinned: true })
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
        // Un-PIN rather than delete: the cover is still perfectly good for browsing, and the LRU
        // reclaims it in its own time if it stops being looked at. Deleting here guaranteed a
        // re-download the next time the user scrolled past the album.
        if (!stillUsed) artStore.setPinned(coverId, false)
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

  // The off-LAN relay privacy toggle (proposal 2026-07-23). Persisted only; the swarm's
  // relayThrough fn reads it live per connect, so no reconnect is needed for it to apply.
  setUseRelay ({ on }) {
    const s = loadSettings()
    s.useRelay = !!on
    saveSettings(s)
    return { useRelay: s.useRelay }
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
    // Since P2 a switch is a POINTER MOVE, not a reconnect: every library is already connected the
    // same way, so the outgoing one keeps its link (a view change is not an unpairing) and the
    // incoming one is adopted if it is up. That is what demoteActiveToPool/promotePoolToActive
    // used to hand-roll, and both of the bugs they were written for (the 2026-07-23 orphan, the
    // 2026-07-24 strand) came from the move itself.
    //
    // A transient failure must not abort the switch: activeHostKey is already persisted and the
    // swarm membership persists, so a connection that misses the wait wires up a moment later and
    // fires host:connected then. Either way we emit host:switched so the UI swaps.
    try {
      await connectTo(host)
    } catch (e) {
      log('switch:connect-deferred', { err: e.message })
    }
    emit('host:switched', { hostKey: host.hostKey, libraryId: host.libraryId, libraryName: labelFor(host.libraryId, host.libraryName), shimPort })
    return { ...host, shimPort }
  },

  // YOUR OWN name for a library (proposal 2026-07-27-local-library-alias). A library is named by
  // its HOST, so without this you cannot relabel a friend's "My Library" at all. Blank clears it
  // and the row falls back to the host's CURRENT name (libraryName keeps tracking the server
  // underneath). Purely local: nothing here is ever sent to a host.
  setLibraryAlias ({ hostKey, alias }) {
    const f = hostList.setAlias(loadHostsFile(), hostKey, alias)
    saveHostsFile(f)
    const rec = f.hosts.find((h) => h.hostKey === hostKey)
    // Same event the operator-rename path fires, so the header, the switcher and the merged
    // chips all relabel off one listener rather than growing an alias-shaped second one.
    if (rec) emit('host:renamed', { hostKey, libraryName: labelFor(rec.libraryId, rec.libraryName), hostName: rec.libraryName, alias: rec.alias || '' })
    // A CLEARED alias can re-create a clash (two libraries both back to "My Library"), and a NEW
    // one can resolve someone else's - so the chips must re-read every label, not just this row's.
    if (mergedMode()) emit('merged:updated', mergedStatusData())
    return listHostsData()
  },

  // The per-library relay-audio consent (proposal 2026-07-29-relay-audio-consent). Called from
  // the prompt the worklet raises on the first relayed playback, and from the library's own
  // settings row so a standing 'deny' is reversible rather than an app that will not play.
  //
  // `value` is 'allow' | 'deny', or anything else to clear it back to "ask me again".
  // `remember` defaults to true (the prompt's checkbox is ticked by default); false keeps the
  // choice for this session only. Purely local, like the alias: no host is told anything, and
  // the host never knew whether a connection was relayed in the first place.
  setRelayAudio ({ libraryId, value, remember = true }) {
    const ok = setRelayAudioConsent(libraryId, value, remember !== false)
    return { ok, ...listHostsData() }
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
      // Leave its topic (stops the swarm trying it + its nudge) and drop its pool connection - the
      // proposal's retry-storm mitigation: remove-library must stop reaching for that host.
      dropLink(removed.libraryId)
      mergedIndex = null // a removed host must leave the blend; next merged browse rebuilds
      mergedConnected.delete(removed.libraryId)
      mergedFresh.delete(removed.libraryId)
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
      // NB the removed library's own link was already dropped above (dropLink), which is what
      // clears `client`/`connected` when it was the default one.
      const next = hostList.activeHost(file)
      if (next) {
        // connectTo ADOPTS next's existing link when it has one (the common case: it was another
        // library a moment ago and is already connected), and dials only when it does not. Before
        // P2 this needed promotePoolToActive, because a redial would dedup against the live
        // connection and stall at "Not connected" (2026-07-24).
        connectTo(next).catch((e) => {
          // Membership persists; a connection that misses the wait wires up later.
          log('remove:reconnect-failed', { err: e.message })
          emit('host:disconnected', { hostKey: next.hostKey })
        })
        emit('host:switched', { hostKey: next.hostKey, libraryId: next.libraryId, libraryName: labelFor(next.libraryId, next.libraryName), shimPort })
      } else {
        // No libraries left: back to un-paired. The removed library's topic is already left (the
        // proposal's retry-storm mitigation - remove-library leaves the topic). The shim keeps
        // listening (its port is stable and harmless); the shell shows the pairing wall.
        defaultLibraryId = null
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
    defaultLibraryId = null

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

    await closeAllLinks() // every library's link, closed and left - this is the full reset
    mergedIndex = null // drop the blended index and its cache-in-memory
    mergedConnected = new Set()
    mergedFresh = new Set()
    buildRouteMaps() // clears the routing lookups
    // A full reset tears the shared transport down too (a later pair recreates it). The swarm
    // OWNS the shared dht node's teardown: Hyperswarm.destroy() destroys its dht even when the
    // node was passed in, so destroy the swarm and let it take the dht with it - destroying the
    // dht separately after would double-destroy. If there is no swarm (never connected this run),
    // fall back to destroying the dht directly.
    if (swarm) { try { await swarm.destroy() } catch {} ; swarm = null; dht = null }
    else if (dht) { try { await dht.destroy() } catch {} ; dht = null }

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
