// Home Assistant speaker control (proposal 2026-08-01-home-assistant-playback, T3).
//
// The host talks to a Home Assistant instance over its REST API to play library
// audio on a `media_player` entity - phase 1 targets the ESPHome Home Assistant
// Voice PE, but nothing here is device-specific.
//
// WHY THE HOST AND NOT THE PHONE. Home Assistant is the party that FETCHES the
// audio: its ESPHome integration builds an ffmpeg-proxy URL, pulls the source
// itself, transcodes it and hands the DEVICE an HA-hosted URL. Measured on the
// Umbrel 2026-08-01: a server bound to 127.0.0.1 only was fetched exactly once,
// from 127.0.0.1, and the speaker played it. So the audio endpoint only has to
// be reachable from HA - which is loopback when they share a box.
//
// THAT IS WHY baseUrl MUST BE LOOPBACK IN PHASE 1. A non-loopback HA is on
// another machine, and serving it would mean publishing the library to the LAN.
// We refuse rather than quietly doing that. See requireLoopback().

const fs = require('fs')
const path = require('path')

const FILE = 'speakers.json'
const VERSION = 1

// Same posture as source.js: a secret is never sent to the browser, and an empty
// field on save means "leave it alone" rather than "set it to empty".
const SECRETS = ['token', 'voiceToken']
// voiceKey is the synthetic device key voice plays as - not a secret (it is a public key
// with no private half anywhere), but not something the browser should be able to set.
const FIELDS = ['enabled', 'baseUrl', 'token', 'voiceEnabled', 'voiceToken', 'voiceKey', 'voiceEntityId', 'haConfigDir']

const DEFAULT_BASE_URL = 'http://127.0.0.1:8123'

// How long we wait on HA. Short: every one of these is on loopback, and a hung
// request would stall a media-channel reply the phone is waiting on.
const TIMEOUT_MS = 5000

// Hostnames that mean "this machine". An IPv6 loopback may arrive bracketed.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1'])

function isLoopbackUrl (raw) {
  let u
  try {
    u = new URL(String(raw || ''))
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  // 127.0.0.0/8 is entirely loopback, not just 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  return LOOPBACK.has(h)
}

// The refusal, in one place so the dashboard and the media channel say the same
// thing. Phase 2 (proposal, Not in scope) is what lifts this.
function requireLoopback (baseUrl) {
  if (isLoopbackUrl(baseUrl)) return null
  return 'Home Assistant must be on this same machine for now (a loopback address ' +
    'like http://127.0.0.1:8123). A Home Assistant somewhere else on the network ' +
    'would mean publishing your library to the network, which PearTune will not do yet.'
}

// CAN WE WRITE HOME ASSISTANT'S CONFIG, and should we?
//
// Deliberately strict. This is the one place PearTune touches a file outside its own data
// directory, so it proves the target really is a Home Assistant config directory (it has a
// configuration.yaml) before it will write anything, and it only ever writes two known
// filenames. A wrong path should fail here, visibly, rather than scatter YAML somewhere.
function canWriteHaConfig (dir) {
  if (!dir) return { ok: false, why: null } // not opted in; not a problem, just off
  let st
  try {
    st = fs.statSync(dir)
  } catch {
    return { ok: false, why: 'That folder does not exist, or PearTune cannot see it.' }
  }
  if (!st.isDirectory()) return { ok: false, why: 'That is a file, not a folder.' }
  if (!fs.existsSync(path.join(dir, 'configuration.yaml'))) {
    return { ok: false, why: 'No configuration.yaml there, so that is not a Home Assistant config folder.' }
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK)
  } catch {
    return { ok: false, why: 'PearTune can see that folder but cannot write to it.' }
  }
  return { ok: true, why: null }
}

function pathOf (dataDir) {
  return path.join(dataDir, FILE)
}

// ONLY the fields actually present. `enabled` used to be coerced unconditionally
// (`out.enabled = !!out.enabled`), which meant ANY caller that omitted it silently
// turned the feature off - a landmine for a partial update, and not something a
// caller could see going wrong. An absent field now means "leave it alone", the
// same rule the secrets already followed.
function pick (cfg) {
  const out = {}
  for (const f of FIELDS) {
    if (cfg[f] !== undefined && cfg[f] !== null) out[f] = cfg[f]
  }
  if (out.baseUrl != null) out.baseUrl = String(out.baseUrl).trim().replace(/\/+$/, '')
  if (out.token != null) out.token = String(out.token).trim()
  if (out.enabled != null) out.enabled = !!out.enabled
  return out
}

class Speakers {
  constructor ({ dataDir, log = () => {} } = {}) {
    this.dataDir = dataDir
    this.log = log
    this.config = this._read()
  }

  _read () {
    // Absent file = disabled, which is what every host in the wild has. Never
    // throw on a malformed file either: a broken speakers.json must not stop a
    // library from serving music.
    try {
      const raw = JSON.parse(fs.readFileSync(pathOf(this.dataDir), 'utf8'))
      if (!raw || typeof raw !== 'object') return this._blank()
      return { ...this._blank(), ...pick(raw) }
    } catch {
      return this._blank()
    }
  }

  _blank () {
    return {
      version: VERSION,
      enabled: false,
      baseUrl: DEFAULT_BASE_URL,
      token: '',
      // Voice control (proposal 2026-08-02). Separate switch from speaker playback: a
      // person may well want to cast from the app without letting anyone in the room
      // start music by talking.
      voiceEnabled: false,
      voiceToken: '',
      voiceKey: '',
      voiceEntityId: '',
      // Where Home Assistant keeps configuration.yaml, IF the operator has opted in to
      // PearTune writing its own config file there. Empty means "we do not touch their
      // files", which is the default and the only behaviour before this existed.
      haConfigDir: ''
    }
  }

  // What the dashboard is allowed to see. Secrets become a boolean - enough to
  // render "configured", never enough to read back.
  publicConfig () {
    const c = this.config
    const out = {
      version: VERSION,
      enabled: c.enabled,
      baseUrl: c.baseUrl,
      voiceEnabled: c.voiceEnabled,
      voiceEntityId: c.voiceEntityId,
      voiceKey: c.voiceKey,
      haConfigDir: this.haConfigDir,
      // Whether we could actually write there right now, so the dashboard can offer the
      // button only when it would work rather than after it fails.
      haConfigWritable: canWriteHaConfig(this.haConfigDir).ok,
      haConfigProblem: canWriteHaConfig(this.haConfigDir).why
    }
    for (const s of SECRETS) out[s + 'Set'] = !!c[s]
    out.loopbackOnly = true
    out.problem = c.enabled ? requireLoopback(c.baseUrl) : null
    return out
  }

  // An empty secret means "keep what is stored". Refuses a non-loopback baseUrl
  // while enabled, so the refusal happens at the moment the operator asks for it
  // rather than silently at play time.
  save (incoming) {
    const next = { ...this.config, ...pick(incoming || {}) }
    for (const s of SECRETS) {
      if (!incoming || incoming[s] === undefined || incoming[s] === '') next[s] = this.config[s]
    }
    if (!next.baseUrl) next.baseUrl = DEFAULT_BASE_URL
    if (next.enabled) {
      const problem = requireLoopback(next.baseUrl)
      if (problem) throw new Error(problem)
      if (!next.token) throw new Error('a Home Assistant long-lived access token is required')
    }
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(pathOf(this.dataDir), JSON.stringify({ ...next, version: VERSION }, null, 2), { mode: 0o600 })
    this.config = next
    this.log('speakers:config-saved', { enabled: next.enabled, baseUrl: next.baseUrl })
    return this.publicConfig()
  }

  // The config folder to offer, preferring what the operator typed over what the platform
  // handed us. The env var is how the Umbrel listing pre-fills the path (PEARTUNE_HA_CONFIG
  // -> /ha-config), so nobody has to know it - pressing the button is still what consents to
  // a write, not the mount existing.
  get haConfigDir () {
    return this.config.haConfigDir || process.env.PEARTUNE_HA_CONFIG || ''
  }

  get enabled () {
    return !!this.config.enabled && !!this.config.token && isLoopbackUrl(this.config.baseUrl)
  }

  async _call (route, { method = 'GET', body = null } = {}) {
    if (!this.config.token) throw new Error('Home Assistant is not configured')
    const problem = requireLoopback(this.config.baseUrl)
    if (problem) throw new Error(problem)

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(this.config.baseUrl + route, {
        method,
        headers: {
          authorization: 'Bearer ' + this.config.token,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      })
      if (res.status === 401 || res.status === 403) {
        throw new Error('Home Assistant rejected the token')
      }
      if (!res.ok) throw new Error(`Home Assistant returned ${res.status}`)
      const text = await res.text()
      return text ? JSON.parse(text) : null
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Home Assistant did not respond')
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  // Does the token work at all. Used by the dashboard's "Test connection".
  async test () {
    await this._call('/api/')
    const list = await this.list()
    return { ok: true, speakers: list.length }
  }

  // Every media_player HA knows about. `supportedFeatures` is HA's live bitmask,
  // and it is DYNAMIC on some platforms - a Cast speaker reports SEEK only while
  // it is playing - so a client must not cache it as a static capability.
  async list () {
    const states = await this._call('/api/states')
    if (!Array.isArray(states)) return []
    return states
      .filter(s => typeof s?.entity_id === 'string' && s.entity_id.startsWith('media_player.'))
      .map(s => ({
        entityId: s.entity_id,
        name: s.attributes?.friendly_name || s.entity_id.slice('media_player.'.length),
        state: s.state,
        supportedFeatures: Number(s.attributes?.supported_features || 0),
        volume: s.attributes?.volume_level ?? null,
        muted: s.attributes?.is_volume_muted ?? null
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async getState (entityId) {
    const s = await this._call('/api/states/' + encodeURIComponent(entityId))
    if (!s) return null
    return {
      entityId: s.entity_id,
      state: s.state,
      volume: s.attributes?.volume_level ?? null,
      muted: s.attributes?.is_volume_muted ?? null,
      // Both come back null on the Voice PE. Passed through rather than faked, so
      // a client can tell "no position information" from "position 0".
      duration: s.attributes?.media_duration ?? null,
      position: s.attributes?.media_position ?? null
    }
  }

  _service (domain, service, data) {
    return this._call(`/api/services/${domain}/${service}`, { method: 'POST', body: data })
  }

  play (entityId, url) {
    return this._service('media_player', 'play_media', {
      entity_id: entityId,
      media_content_id: url,
      media_content_type: 'music'
    })
  }

  stop (entityId) {
    return this._service('media_player', 'media_stop', { entity_id: entityId })
  }

  pause (entityId) {
    return this._service('media_player', 'media_pause', { entity_id: entityId })
  }

  resume (entityId) {
    return this._service('media_player', 'media_play', { entity_id: entityId })
  }

  setVolume (entityId, level) {
    const v = Math.max(0, Math.min(1, Number(level)))
    return this._service('media_player', 'volume_set', { entity_id: entityId, volume_level: v })
  }
}

module.exports = { Speakers, isLoopbackUrl, requireLoopback, canWriteHaConfig, DEFAULT_BASE_URL, SPEAKERS_FILE: FILE }
