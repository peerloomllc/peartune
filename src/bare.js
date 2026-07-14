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
const hcrypto = require('hypercore-crypto')

const { PearTuneClient } = require('../client')
const { createAudioShim } = require('../worklet/shim')
const { isPairLink } = require('../protocol/link')

const DATA_DIR = Bare.argv[0] || '/tmp/peartune'
const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json')
const HOSTS_FILE = path.join(DATA_DIR, 'hosts.json')

let client = null
let shim = null
let shimPort = null
let identity = null
let currentHost = null

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

  // The shim only exists while we are connected; playback flows THROUGH the
  // connection, which is what makes a revoke actually stop the music.
  if (!shim) {
    shim = createAudioShim({ client, log })
    shimPort = await shim.listen()
  }

  // If the host revokes us, our connection is destroyed. Tell the shell so it can
  // stop the player and say why, instead of leaving a silent dead player on
  // screen.
  client.conn.once('close', () => {
    log('host:disconnected')
    emit('host:disconnected', { hostKey: host.hostKey })
  })

  emit('host:connected', {
    libraryName: host.libraryName,
    libraryId: host.libraryId,
    shimPort
  })

  return { ...host, shimPort }
}

// --- methods ----------------------------------------------------------------

const methods = {
  async init () {
    identity = loadIdentity()
    const host = loadHost()
    const state = {
      deviceKey: b4a.toString(identity.publicKey, 'hex'),
      host: host || null,
      connected: false
    }
    if (host) {
      try {
        await connectTo(host)
        state.connected = true
        state.shimPort = shimPort
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

  async stats () {
    return client.stats()
  },

  async tracks ({ cursor = 0, limit = 200 } = {}) {
    return client.list({ type: 'tracks', cursor, limit })
  },

  // Album browsing is the primary way in. A flat list of 1358 tracks is not a
  // music app, and Subsonic has no "all songs" call anyway - so the flat list
  // could only ever show the first page. Albums page properly.
  async albums ({ cursor = 0, limit = 60 } = {}) {
    const page = await client.list({ type: 'albums', cursor, limit })
    return {
      ...page,
      items: page.items.map(a => ({
        ...a,
        // Pre-resolve the loopback URL so the WebView can <img src> it directly.
        art: a.coverId && shim ? shim.artUrlFor(a.coverId) : null
      }))
    }
  },

  async album ({ id }) {
    const a = await client.get({ id, type: 'album' })
    if (!a) return null
    return {
      ...a,
      art: a.coverId && shim ? shim.artUrlFor(a.coverId) : null
    }
  },

  async search ({ q }) {
    const r = await client.search({ q })
    return {
      ...r,
      albums: (r.albums || []).map(a => ({
        ...a,
        art: a.coverId && shim ? shim.artUrlFor(a.coverId) : null
      }))
    }
  },

  // The URL the RN player hands to ExoPlayer. The audio never touches RN: the
  // player pulls it from the worklet's loopback server, which pulls it over P2P.
  urlFor ({ trackId }) {
    if (!shim) throw new Error('not connected')
    return { url: shim.urlFor(trackId), port: shimPort }
  },

  async forget () {
    try {
      fs.unlinkSync(HOSTS_FILE)
    } catch {}
    if (client) await client.close()
    client = null
    shim = null
    currentHost = null
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
