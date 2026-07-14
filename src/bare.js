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
const { isPairLink } = require('../protocol/link')

const DATA_DIR = Bare.argv[0] || '/tmp/peartune'
const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json')
const HOSTS_FILE = path.join(DATA_DIR, 'hosts.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

const DEFAULT_SETTINGS = { theme: 'system' }

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
    shim = createAudioShim({ client, log, ensure: ensureConnected })
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

  async pair ({ link, label }) {
    if (!isPairLink(link)) throw new Error('That is not a PearTune pairing code.')
    await ensureClient()

    const paired = await client.pair(link, {
      label: label || 'Android phone',
      platform: 'android'
    })

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

  async setSettings (patch) {
    return saveSettings(patch || {})
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
