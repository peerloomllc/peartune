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

// The loopback port the audio and voice routes listen on. Fixed so the voice endpoint has a
// stable address to put in a configuration file; overridable for the rare collision.
const PREFERRED_PORT = Number(process.env.PEARTUNE_CAST_PORT || 8742)

// How many tracks a spoken request queues up. Long enough that "put on Led Zeppelin" is an
// evening rather than a song, short enough that resolving it is not a library scan.
const VOICE_QUEUE_MAX = 50

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
    // deviceKey -> { items: [trackId], index }. A HOST-HELD queue, for casts that have no
    // phone behind them. An app-driven cast advances because the app hears speaker:ended and
    // sends the next track; a VOICE cast has nobody to hear that, so it played exactly one
    // song and stopped - which is what Tim saw as "always the same song".
    this.queues = new Map()

    this.server = null
    this.port = 0
    this.timer = null
  }

  // A STABLE port on loopback, not an ephemeral one.
  //
  // It used to be ephemeral, on the reasoning that nothing outside the process needs to
  // guess it - the audio URL is handed to Home Assistant directly. Voice control broke
  // that: its endpoint goes in the operator's configuration.yaml BY HAND, and a port that
  // changed on every host restart would silently break that file every time. Tim hit the
  // first half of this immediately ("I see a token generated, but nothing about a port").
  //
  // Falls back to ephemeral if the port is taken, rather than refusing to start - a
  // library that will not serve music because a port is busy would be a bad trade. The
  // dashboard shows whichever port was actually taken, so the config can be regenerated.
  async start () {
    if (this.server) return this.port
    this.server = http.createServer((req, res) => this._serve(req, res))
    const listen = (srv, port) => new Promise((resolve, reject) => {
      const onErr = (e) => { srv.removeListener('error', onErr); reject(e) }
      srv.once('error', onErr)
      srv.listen(port, '127.0.0.1', () => { srv.removeListener('error', onErr); resolve() })
    })
    try {
      await listen(this.server, PREFERRED_PORT)
    } catch (e) {
      // A FRESH server for the retry. An http.Server whose listen() failed cannot simply
      // be listened on again - it comes back bound to nothing and every request to it
      // fails, which is exactly how this showed up in the suite.
      this.log('cast:port-busy', { port: PREFERRED_PORT, err: e?.code })
      try { this.server.close() } catch {}
      this.server = http.createServer((req, res) => this._serve(req, res))
      await listen(this.server, 0)
    }
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

    let picked = null
    try {
      picked = await this._resolveVoiceQuery(query)
    } catch (e) {
      this.log('voice:search-failed', { err: e?.message })
      return say(500, { error: 'search failed' })
    }
    if (!picked) {
      // A clean miss, so Home Assistant can SAY "I could not find that". The first cut
      // returned this and the automation ignored it, so an unknown artist was silence -
      // which is the worst possible answer to a spoken request (Tim, 2026-08-02: "it
      // silently fails when it can't figure out what to play"). NOT a music request:
      // that is a different feature, deliberately.
      this.log('voice:no-match', { query })
      return say(404, { error: 'not in the library', query })
    }

    try {
      await this.play({
        deviceKey: cfg.voiceKey,
        trackId: picked.tracks[0],
        entityId,
        queue: picked.tracks,
        // What to call this later. "Shuffling Led Zeppelin" beats "OK" (Tim, 2026-08-02).
        label: picked.artist || picked.title || null
      })
    } catch (e) {
      this.log('voice:play-failed', { err: e?.message })
      return say(500, { error: e?.message || 'could not play' })
    }
    this.log('voice:play', { query, entityId, kind: picked.kind, tracks: picked.tracks.length })
    return say(200, {
      ok: true,
      kind: picked.kind,
      title: picked.title || null,
      artist: picked.artist || null,
      count: picked.tracks.length
    })
  }

  // POST /voice/control { token, action } - next / previous / stop / shuffle.
  //
  // These act on the HOST-HELD QUEUE, not on the speaker, because the speaker has no queue:
  // it is handed one track at a time. Telling it to "skip" would do nothing even on a device
  // that claimed the feature.
  async _voiceControl (req, res, body) {
    const cfg = this.speakers.config || {}
    const say = (code, msg) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(msg))
    }
    if (!cfg.voiceEnabled || !cfg.voiceToken) return say(404, { error: 'voice is off' })
    if (!body?.token || String(body.token) !== cfg.voiceToken) {
      this.log('voice:denied', { reason: 'token' })
      return say(403, { error: 'bad token' })
    }

    const action = String(body.action || '').trim()
    const key = cfg.voiceKey
    const q = this.queues.get(key)
    const entityId = [...(this.byDevice.get(key)?.keys() || [])][0] || cfg.voiceEntityId

    if (action === 'stop') {
      // A real stop, not the pause that "stop playing" gets from Home Assistant's built-in
      // intent: the cast ends, the token dies and the queue is forgotten.
      const n = await this.stopFor(key)
      this.log('voice:stop', { silenced: n })
      return say(200, { ok: true, action })
    }

    if (!q || !entityId) return say(409, { error: 'nothing is playing' })

    if (action === 'next' || action === 'previous') {
      const at = action === 'next' ? q.index + 1 : q.index - 1
      if (at < 0) return say(409, { error: 'at the start' })
      if (at >= q.items.length) return say(409, { error: 'at the end' })
      q.index = at
      await this.play({ deviceKey: key, trackId: q.items[at], entityId })
      this.log('voice:' + action, { at, of: q.items.length })
      return say(200, { ok: true, action, at, of: q.items.length, label: q.label || null })
    }

    if (action === 'shuffle') {
      // Shuffle what is STILL TO COME and leave the current track alone - reordering
      // something already playing would mean restarting it, which is not what anyone means
      // by "shuffle". Fisher-Yates over the tail.
      const tail = q.items.slice(q.index + 1)
      for (let i = tail.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[tail[i], tail[j]] = [tail[j], tail[i]]
      }
      q.items = [...q.items.slice(0, q.index + 1), ...tail]
      this.log('voice:shuffle', { remaining: tail.length })
      return say(200, { ok: true, action, remaining: tail.length, label: q.label || null })
    }

    return say(400, { error: 'unknown action', action })
  }

  // Turn a spoken phrase into something to play, and something to play AFTER it.
  //
  // The first cut took `search().tracks[0]` and nothing else, which is why "put on Led
  // Zeppelin" always got the same song and an artist we hold no track titles for came back
  // empty. `search()` returns `{ artists, albums, tracks }` and all three are useful:
  //
  //   - a TRACK whose title really matches wins, because asking for a song by name should
  //     get that song and not the first thing by that artist,
  //   - otherwise an ARTIST or ALBUM whose NAME matches becomes a queue of their music,
  //   - otherwise the loose track matches (which include matches on artist and album) are
  //     the queue, in the order the adapter ranked them.
  async _resolveVoiceQuery (query) {
    const adapter = this.getAdapter()
    const r = await adapter.search({ q: query, limit: VOICE_QUEUE_MAX })
    const artists = r?.artists || []
    const albums = r?.albums || []
    const tracks = r?.tracks || []
    const norm = (x) => String(x || '').toLowerCase().trim()
    const want = norm(query)

    // 1. An exact-ish TRACK title. "put on rock and roll" means that song.
    const titled = tracks.find(t => norm(t.title) === want) ||
      tracks.find(t => norm(t.title).startsWith(want))
    if (titled) {
      // ...and then KEEP GOING with more by the same artist. A named song that stops dead
      // after three minutes is the same silence Tim complained about, just delayed - a
      // music player plays the song you asked for and then carries on.
      const id = titled.id || titled.trackId
      let rest = tracks.filter(t => (t.id || t.trackId) !== id)
      if (!rest.length && titled.artist) {
        const more = await adapter.search({ q: titled.artist, limit: VOICE_QUEUE_MAX }).catch(() => null)
        rest = (more?.tracks || []).filter(t => (t.id || t.trackId) !== id)
      }
      return {
        kind: 'track',
        title: titled.title,
        artist: titled.artist,
        tracks: [id, ...rest.map(t => t.id || t.trackId)].filter(Boolean).slice(0, VOICE_QUEUE_MAX)
      }
    }

    // 2. An ARTIST by name. Their tracks are usually already in `tracks` (the adapters match
    //    on artist too), so prefer that over walking albums - one call instead of many.
    const artist = artists.find(a => norm(a.name) === want) ||
      artists.find(a => norm(a.name).startsWith(want)) || artists[0]
    if (artist) {
      const theirs = tracks.filter(t => norm(t.artist) === norm(artist.name))
      const ids = (theirs.length ? theirs : tracks).map(t => t.id || t.trackId).filter(Boolean)
      if (ids.length) {
        return { kind: 'artist', artist: artist.name, tracks: ids.slice(0, VOICE_QUEUE_MAX) }
      }
      // An artist we matched but hold no loose track rows for: walk their albums.
      const ids2 = await this._tracksOfArtist(adapter, artist.id)
      if (ids2.length) return { kind: 'artist', artist: artist.name, tracks: ids2 }
    }

    // 3. An ALBUM by name.
    const album = albums.find(a => norm(a.name) === want) || albums.find(a => norm(a.name).startsWith(want))
    if (album) {
      const full = await adapter.get({ id: album.id, type: 'album' }).catch(() => null)
      const ids = (full?.tracks || []).map(t => t.id || t.trackId).filter(Boolean)
      if (ids.length) return { kind: 'album', title: album.name, artist: album.artist, tracks: ids.slice(0, VOICE_QUEUE_MAX) }
    }

    // 4. Whatever the search turned up, in its own order.
    const loose = tracks.map(t => t.id || t.trackId).filter(Boolean)
    if (loose.length) {
      return { kind: 'search', title: tracks[0].title, artist: tracks[0].artist, tracks: loose.slice(0, VOICE_QUEUE_MAX) }
    }
    return null
  }

  // Every track on every album an artist has. Only reached when the loose search rows did
  // not already carry them, because it is several calls where that was one.
  async _tracksOfArtist (adapter, artistId) {
    const a = await adapter.get({ id: artistId, type: 'artist' }).catch(() => null)
    if (!a) return []
    const ids = (a.tracks || []).map(t => t.id || t.trackId).filter(Boolean)
    for (const al of (a.albums || [])) {
      if (ids.length >= VOICE_QUEUE_MAX) break
      const full = await adapter.get({ id: al.id, type: 'album' }).catch(() => null)
      for (const t of (full?.tracks || [])) {
        const id = t.id || t.trackId
        if (id) ids.push(id)
      }
    }
    return ids.slice(0, VOICE_QUEUE_MAX)
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

      if (url.pathname === '/voice/play' || url.pathname === '/voice/control') {
        if (req.method !== 'POST') return deny(405)
        const chunks = []
        for await (const c of req) {
          chunks.push(c)
          // A voice command is a short JSON object. Anything larger is not one.
          if (chunks.reduce((n, b) => n + b.length, 0) > 8192) return deny(413)
        }
        let body = null
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return deny(400) }
        return url.pathname === '/voice/play'
          ? this._voicePlay(req, res, body)
          : this._voiceControl(req, res, body)
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

  async play ({ deviceKey, trackId, entityId, queue = null, label = null }) {
    if (!this.speakers.enabled) throw new Error('Home Assistant is not configured')
    await this.start()

    // A queue means "and keep going" - see this.queues. Replaces any previous one for this
    // device, so a second voice request abandons the first rather than interleaving.
    if (queue && queue.length) this.queues.set(deviceKey, { items: queue, index: 0, label })
    else if (queue !== null) this.queues.delete(deviceKey)

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
    this.queues.delete(deviceKey)

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

        // A HOST-HELD queue advances here, because nothing else can: there is no app on the
        // other end of a voice cast. An app-driven cast has no queue here and falls through
        // to the push, which is what it has always done.
        const q = this.queues.get(deviceKey)
        if (q && q.index + 1 < q.items.length) {
          q.index++
          try {
            await this.play({ deviceKey, trackId: q.items[q.index], entityId })
            // play() with no queue leaves this.queues alone, so the label survives.
            this.log('cast:queue-advance', { at: q.index, of: q.items.length })
            continue
          } catch (e) {
            this.log('cast:queue-advance-failed', { err: e?.message })
            this.queues.delete(deviceKey)
          }
        } else if (q) {
          this.log('cast:queue-done', { of: q.items.length })
          this.queues.delete(deviceKey)
        }

        if (this.presence) {
          this.presence.notify(deviceKey, 'speaker:ended', { entityId, trackId: row.trackId })
        }
      }
    }
    if (!this.byDevice.size) this._stopPolling()
  }
}

module.exports = { CastSessions, CAST_SCOPES, TOKEN_TTL_MS }
