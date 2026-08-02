// Casting a track to a Home Assistant speaker (proposal 2026-08-01, T3).
//
// THE SECURITY SHAPE, because this is the part that can go wrong quietly.
//
// `Connections.kill()` in gate.js is the whole of the revoke teeth: it destroys a
// device's HyperDHT connections. A SPEAKER IS NOT ONE OF THOSE. Under this feature
// the audio reaches the speaker from this process to Home Assistant, on a path with
// no relationship to the revoked phone's connection - so revoking a phone mid-song
// would leave the music playing in the room unless we do something about it here.
//
// So there are TWO mechanisms and BOTH are required:
//
//   1. Every fetch of an audio URL RE-READS THE LIVE GRANT. A revoked device fails
//      its next fetch. Necessary, not sufficient: HA plus ffmpeg buffer well ahead
//      of the speaker, so the room can keep playing for a while after the last GET.
//
//   2. Revoke actively calls media_stop on every entity that device has playing.
//      This is what makes the room go quiet. `stopFor()` is the entry point, and
//      the host calls it everywhere it calls connections.kill().
//
// The audio listener binds 127.0.0.1 ONLY, deliberately NOT sharing the dashboard's
// server: the dashboard binds 0.0.0.0 in a container (PEARTUNE_HTTP_HOST in the
// Umbrel compose), and hanging library audio off that would publish it to the LAN
// behind nothing but a dashboard password.

const crypto = require('crypto')
const http = require('http')

const { decide } = require('./gate')
const { SCOPE } = require('../protocol/constants')

// A cast token outlives one track by a margin, not by hours: HA re-fetches (the
// spike saw two GETs for one track), and a long tail is a bigger window for a
// token that leaked to a co-resident process.
const TOKEN_TTL_MS = 60 * 60 * 1000

// How often we ask HA what the entity is doing, while a cast is live. Only runs
// while at least one cast exists, so an idle host makes no HA traffic at all.
const POLL_MS = 2000

// Who may make noise in someone else's house. OWNER only in phase 1 (proposal,
// Open question 1): a guest streaming to their own headphones is one thing, a
// guest starting the kitchen speaker is another. Easy to relax, painful to tighten.
const CAST_SCOPES = new Set([SCOPE.OWNER])

function newToken () {
  return crypto.randomBytes(32).toString('base64url')
}

class CastSessions {
  constructor ({ speakers, grants, getAdapter, presence = null, log = () => {} }) {
    this.speakers = speakers
    this.grants = grants
    this.getAdapter = getAdapter
    this.presence = presence
    this.log = log

    // token -> { deviceKey, trackId, entityId, expiresAt }
    this.tokens = new Map()
    // deviceKey -> Map<entityId, { token, trackId, startedAt, sawPlaying }>
    this.byDevice = new Map()

    this.server = null
    this.port = 0
    this.timer = null
  }

  // Binds an ephemeral port on loopback. Ephemeral because nothing outside this
  // process ever needs to guess it - the URL is handed to HA directly.
  async start () {
    if (this.server) return this.port
    this.server = http.createServer((req, res) => this._serve(req, res))
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.port = this.server.address().port
    this.log('cast:listening', { port: this.port, bind: '127.0.0.1' })
    return this.port
  }

  async close () {
    this._stopPolling()
    for (const deviceKey of [...this.byDevice.keys()]) {
      // Best-effort: a host shutting down should not leave a speaker playing from
      // a URL that is about to stop answering.
      await this.stopFor(deviceKey).catch(() => {})
    }
    this.tokens.clear()
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve))
      this.server = null
    }
  }

  // --- voice control (proposal 2026-08-02) --------------------------------
  //
  // POST /voice/play { token, query, entityId } - Home Assistant's rest_command, forwarding
  // a sentence someone said in the room.
  //
  // ON THE SAME LOOPBACK SERVER AS THE AUDIO, deliberately, and NOT on the dashboard: the
  // dashboard binds 0.0.0.0 in a container, so a "make the library play" endpoint there
  // would be published to the LAN.
  //
  // THE AUTHORITY QUESTION (proposal, T3). Everything else that plays this library is a
  // device holding a grant. Voice is not - the person speaking holds no grant. So voice
  // plays as a REAL grant of its own, minted against a synthetic device key, which means
  // revoking voice is the SAME revoke as revoking a phone: the audio route's live grant
  // re-read denies it, and stopFor silences the speaker. No special case in the security
  // path, which is the whole reason to do it this way.
  //
  // The key is a random 32 bytes with NO private half anywhere, so it can never open a
  // Noise connection. The grant is reachable only from this loopback route.
  async _voicePlay (req, res, body) {
    const cfg = this.speakers.config || {}
    const say = (code, msg) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(msg))
    }

    if (!cfg.voiceEnabled || !cfg.voiceToken) return say(404, { error: 'voice is off' })
    // Constant-length compare is overkill on loopback, but the token is the whole gate.
    if (!body?.token || String(body.token) !== cfg.voiceToken) {
      this.log('voice:denied', { reason: 'token' })
      return say(403, { error: 'bad token' })
    }

    const query = String(body.query || '').trim()
    if (!query) return say(400, { error: 'nothing to search for' })
    const entityId = String(body.entityId || cfg.voiceEntityId || '').trim()
    if (!entityId) return say(400, { error: 'no speaker configured' })

    let hit = null
    try {
      const r = await this.getAdapter().search({ q: query, limit: 1 })
      // Adapters return shapes that differ in the wrapper but agree on the rows.
      const rows = Array.isArray(r) ? r : (r?.tracks || r?.results || [])
      hit = rows[0] || null
    } catch (e) {
      this.log('voice:search-failed', { err: e?.message })
      return say(500, { error: 'search failed' })
    }
    if (!hit) {
      // A clean miss, so Home Assistant can say "I could not find that" rather than
      // failing silently. NOT a music request - that is a different feature deliberately.
      this.log('voice:no-match', { query })
      return say(404, { error: 'not in the library', query })
    }

    try {
      await this.play({ deviceKey: cfg.voiceKey, trackId: hit.id || hit.trackId, entityId })
    } catch (e) {
      this.log('voice:play-failed', { err: e?.message })
      return say(500, { error: e?.message || 'could not play' })
    }
    this.log('voice:play', { query, entityId, title: hit.title })
    return say(200, { ok: true, title: hit.title || null, artist: hit.artist || null })
  }

  // --- the audio route ---------------------------------------------------
  //
  // One route, GET /a/<token>. No Range support: HA's ffmpeg proxy reads straight
  // through, and the phase-1 target device cannot seek anyway (it reports no SEEK
  // feature). Cast devices in phase 2 DO want Range - see the proposal.
  async _serve (req, res) {
    const deny = (code) => {
      // No body and no reason. A caller that is not HA has no business learning
      // whether a token was wrong, expired or revoked.
      res.writeHead(code)
      res.end()
    }

    try {
      const url = new URL(req.url, 'http://127.0.0.1')

      if (url.pathname === '/voice/play') {
        if (req.method !== 'POST') return deny(405)
        const chunks = []
        for await (const c of req) {
          chunks.push(c)
          // A voice command is a short JSON object. Anything larger is not one.
          if (chunks.reduce((n, b) => n + b.length, 0) > 8192) return deny(413)
        }
        let body = null
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return deny(400) }
        return this._voicePlay(req, res, body)
      }

      const m = /^\/a\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
      if (!m) return deny(404)
      if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405)

      const entry = this.tokens.get(m[1])
      if (!entry) return deny(404)
      if (Date.now() > entry.expiresAt) {
        this.tokens.delete(m[1])
        return deny(404)
      }

      // THE LIVE RE-READ. Not the grant we minted with - the grant as it is right
      // now. This is what makes a revoked, expired or person-revoked device fail
      // its next fetch mid-cast.
      const lookup = await this.grants.lookup(entry.deviceKey)
      const verdict = decide(lookup)
      if (!verdict.allow || !CAST_SCOPES.has(lookup.grant?.scope)) {
        this.log('cast:fetch-denied', {
          device: String(entry.deviceKey).slice(0, 8),
          reason: verdict.allow ? 'scope' : verdict.reason
        })
        this.tokens.delete(m[1])
        return deny(403)
      }

      const stream = await this.getAdapter().stream({ trackId: entry.trackId })
      if (!stream) return deny(404)

      res.writeHead(200, { 'content-type': 'audio/mpeg', 'accept-ranges': 'none' })
      if (req.method === 'HEAD') {
        stream.destroy?.()
        return res.end()
      }
      stream.on('error', () => res.destroy())
      res.on('close', () => stream.destroy?.())
      stream.pipe(res)
    } catch (e) {
      this.log('cast:serve-failed', { err: e?.message })
      try { deny(500) } catch {}
    }
  }

  // --- control -----------------------------------------------------------

  // Is this grant allowed to cast at all? Exported so the media channel can refuse
  // with a typed error before doing any work, and so the rule lives in ONE place.
  static allows (grant) {
    return !!grant && !grant.revokedAt && CAST_SCOPES.has(grant.scope)
  }

  async play ({ deviceKey, trackId, entityId }) {
    if (!this.speakers.enabled) throw new Error('Home Assistant is not configured')
    await this.start()

    // Replace whatever this device had on this entity, rather than stacking
    // tokens: one device plays one thing on one speaker.
    const prev = this.byDevice.get(deviceKey)?.get(entityId)
    if (prev) this.tokens.delete(prev.token)

    const token = newToken()
    this.tokens.set(token, {
      deviceKey,
      trackId,
      entityId,
      expiresAt: Date.now() + TOKEN_TTL_MS
    })

    let set = this.byDevice.get(deviceKey)
    if (!set) {
      set = new Map()
      this.byDevice.set(deviceKey, set)
    }
    set.set(entityId, { token, trackId, startedAt: Date.now(), sawPlaying: false })

    const url = `http://127.0.0.1:${this.port}/a/${token}`
    try {
      await this.speakers.play(entityId, url)
    } catch (e) {
      // Do not leave a live token behind for a play that never started.
      this.tokens.delete(token)
      set.delete(entityId)
      if (!set.size) this.byDevice.delete(deviceKey)
      throw e
    }

    this.log('cast:play', { device: String(deviceKey).slice(0, 8), entityId, trackId })
    this._startPolling()
    return { ok: true }
  }

  async stop (deviceKey, entityId) {
    const set = this.byDevice.get(deviceKey)
    const row = set?.get(entityId)
    if (row) {
      this.tokens.delete(row.token)
      set.delete(entityId)
      if (!set.size) this.byDevice.delete(deviceKey)
    }
    await this.speakers.stop(entityId).catch(() => {})
    if (!this.byDevice.size) this._stopPolling()
    return { ok: true }
  }

  // THE REVOKE PATH. Called wherever the host calls connections.kill(). Kills the
  // tokens AND silences the speakers - the token alone would leave the room playing
  // out whatever HA had already buffered.
  async stopFor (deviceKey) {
    const set = this.byDevice.get(deviceKey)
    if (!set || !set.size) return 0
    const entities = [...set.keys()]
    for (const row of set.values()) this.tokens.delete(row.token)
    this.byDevice.delete(deviceKey)

    let stopped = 0
    for (const entityId of entities) {
      try {
        await this.speakers.stop(entityId)
        stopped++
      } catch (e) {
        // Log loudly. A speaker we failed to silence is a security-relevant
        // failure, not a cosmetic one.
        this.log('cast:stop-failed', { entityId, err: e?.message })
      }
    }
    this.log('cast:stopped-for-device', {
      device: String(deviceKey).slice(0, 8), entities: entities.length, stopped
    })
    if (!this.byDevice.size) this._stopPolling()
    return stopped
  }

  async stopForAll (deviceKeys) {
    let n = 0
    for (const k of deviceKeys) n += await this.stopFor(k)
    return n
  }

  // Every device with a live cast. The expiry sweep needs this: it walks LIVE
  // CONNECTIONS, and a phone can start a cast and then close the app - leaving a
  // speaker playing for a device the sweep would never look at.
  deviceKeys () {
    return [...this.byDevice.keys()]
  }

  // Which entities a device currently has playing. Used by the media channel so a
  // phone reopening the app can re-attach to a cast it started.
  active (deviceKey) {
    const set = this.byDevice.get(deviceKey)
    if (!set) return []
    return [...set.entries()].map(([entityId, row]) => ({
      entityId, trackId: row.trackId, startedAt: row.startedAt
    }))
  }

  // --- end of track ------------------------------------------------------
  //
  // The speaker has no queue (no MEDIA_ENQUEUE on either the ESPHome or the Cast
  // platform), so SOMETHING has to notice a track finished and send the next one.
  // That something is the phone, which owns the queue - we just tell it when.
  //
  // `sawPlaying` guards the startup race: an entity is still 'idle' for a beat
  // after play_media returns, and treating that as "ended" would fire instantly.
  _startPolling () {
    if (this.timer || !this.byDevice.size) return
    this.timer = setInterval(() => { this._poll().catch(() => {}) }, POLL_MS)
    this.timer.unref?.()
  }

  _stopPolling () {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  async _poll () {
    for (const [deviceKey, set] of [...this.byDevice.entries()]) {
      for (const [entityId, row] of [...set.entries()]) {
        let state
        try {
          state = await this.speakers.getState(entityId)
        } catch {
          continue // HA blipped; try again next tick rather than ending the cast
        }
        if (!state) continue

        if (state.state === 'playing') {
          row.sawPlaying = true
          continue
        }
        // 'unavailable' means HA or the device went away - treat it as the end of
        // the cast rather than retrying forever (proposal, Open question 4).
        const ended = row.sawPlaying && (state.state === 'idle' || state.state === 'off' ||
          state.state === 'standby' || state.state === 'unavailable')
        if (!ended) continue

        this.tokens.delete(row.token)
        set.delete(entityId)
        if (!set.size) this.byDevice.delete(deviceKey)
        this.log('cast:ended', { device: String(deviceKey).slice(0, 8), entityId, state: state.state })
        if (this.presence) {
          this.presence.notify(deviceKey, 'speaker:ended', { entityId, trackId: row.trackId })
        }
      }
    }
    if (!this.byDevice.size) this._stopPolling()
  }
}

module.exports = { CastSessions, CAST_SCOPES, TOKEN_TTL_MS }
