// Casting to a Home Assistant speaker (proposal 2026-08-01).
//
// The audio route is a NEW way to get bytes out of the library, and it is NOT
// covered by the revoke machinery that protects the P2P path: Connections.kill()
// destroys HyperDHT connections, and a speaker is not one. So the tests that
// matter here are the ones that prove a revoked device stops getting audio, and
// that revoke actually silences the speaker rather than only closing the tap.
//
// Every fetch below goes through the real http server on real loopback, because
// "the token check runs on every request" is precisely the thing that would rot
// if it were only asserted against a mocked handler.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('stream')
const path = require('path')

// Ephemeral ports here: every test stands up its own server, and they would otherwise all
// contend for the one fixed port the host prefers. The preference itself is tested below.
process.env.PEARTUNE_CAST_PORT = '0'

const { CastSessions } = require('../host/cast')
const { Speakers, isLoopbackUrl, requireLoopback } = require('../host/speakers')

const DEVICE = 'device-key-aaa'
const OTHER = 'device-key-bbb'

// A grants double with the same shape host/grants.js exposes to cast.js.
function fakeGrants (rows) {
  return {
    rows,
    async lookup (deviceKey) {
      const grant = this.rows[deviceKey] || null
      return { grant, person: grant?.person || null }
    }
  }
}

const okGrant = (over = {}) => ({
  deviceKey: DEVICE, revokedAt: null, expiresAt: null, scope: 'owner', person: null, ...over
})

// Records what HA was asked to do, so "revoke silenced the speaker" is an
// assertion about a call that was actually made.
function fakeSpeakers () {
  return {
    enabled: true,
    calls: [],
    states: new Map(),
    async play (entityId, url) { this.calls.push(['play', entityId, url]) },
    async stop (entityId) { this.calls.push(['stop', entityId]) },
    async getState (entityId) { return this.states.get(entityId) || null },
    async setVolume () {},
    async pause (entityId) { this.calls.push(['pause', entityId]) },
    async resume (entityId) { this.calls.push(['resume', entityId]) }
  }
}

const fakeAdapter = () => ({
  async stream () { return Readable.from([Buffer.from('AUDIOBYTES')]) }
})

async function build (grantRows) {
  const speakers = fakeSpeakers()
  const grants = fakeGrants(grantRows)
  const casts = new CastSessions({ speakers, grants, getAdapter: fakeAdapter })
  const port = await casts.start()
  return { casts, speakers, grants, port }
}

// The URL cast.js handed HA, which is the only way a real fetch could happen.
const urlOf = (speakers) => speakers.calls.find(c => c[0] === 'play')[2]

test('the preferred port is used when free, and a busy one falls back cleanly', async (t) => {
  // Directly, because the suite as a whole runs on ephemeral ports (see the top of file).
  const http = require('http')
  const PORT = 18742
  const blocker = http.createServer(() => {})
  await new Promise(r => blocker.listen(PORT, '127.0.0.1', r))
  t.after(() => new Promise(r => blocker.close(r)))

  process.env.PEARTUNE_CAST_PORT = String(PORT)
  delete require.cache[require.resolve('../host/cast')]
  const { CastSessions: Fresh } = require('../host/cast')

  const speakers = fakeSpeakers()
  const casts = new Fresh({ speakers, grants: fakeGrants({}), getAdapter: fakeAdapter })
  const port = await casts.start()
  t.after(() => casts.close())

  // The preferred port was taken, so it fell back - and the fallback must actually WORK,
  // which is the half that broke: a server whose listen() failed cannot be relisted.
  assert.notEqual(port, PORT)
  assert.equal(casts.server.address().address, '127.0.0.1')
  assert.equal((await fetch(`http://127.0.0.1:${port}/a/nope`)).status, 404)

  process.env.PEARTUNE_CAST_PORT = '0'
  delete require.cache[require.resolve('../host/cast')]
})

test('the audio listener binds loopback only', async (t) => {
  const { casts, port } = await build({ [DEVICE]: okGrant() })
  t.after(() => casts.close())
  const addr = casts.server.address()
  assert.equal(addr.address, '127.0.0.1')
  assert.ok(port > 0)
})

test('a live owner grant can fetch its own cast audio', async (t) => {
  const { casts, speakers } = await build({ [DEVICE]: okGrant() })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.x' })
  const res = await fetch(urlOf(speakers))
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'AUDIOBYTES')
})

test('REVOKED mid-cast: the very next fetch is refused', async (t) => {
  const rows = { [DEVICE]: okGrant() }
  const { casts, speakers, grants } = await build(rows)
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.x' })
  const url = urlOf(speakers)
  assert.equal((await fetch(url)).status, 200)

  // The revoke a dashboard would write. Note we do NOT touch the token store here -
  // the point is that the LIVE GRANT RE-READ is what refuses, all on its own.
  grants.rows[DEVICE].revokedAt = Date.now()
  assert.equal((await fetch(url)).status, 403)
})

test('an EXPIRED grant is refused mid-cast', async (t) => {
  const rows = { [DEVICE]: okGrant() }
  const { casts, speakers, grants } = await build(rows)
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.x' })
  const url = urlOf(speakers)
  assert.equal((await fetch(url)).status, 200)

  grants.rows[DEVICE].expiresAt = Date.now() - 1
  assert.equal((await fetch(url)).status, 403)
})

test('a revoked PERSON is refused mid-cast, even with a live device row', async (t) => {
  const rows = { [DEVICE]: okGrant({ person: { revokedAt: null } }) }
  const { casts, speakers, grants } = await build(rows)
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.x' })
  const url = urlOf(speakers)
  assert.equal((await fetch(url)).status, 200)

  grants.rows[DEVICE].person.revokedAt = Date.now()
  assert.equal((await fetch(url)).status, 403)
})

test('a grant DEMOTED out of owner scope is refused mid-cast', async (t) => {
  const rows = { [DEVICE]: okGrant() }
  const { casts, speakers, grants } = await build(rows)
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.x' })
  const url = urlOf(speakers)
  assert.equal((await fetch(url)).status, 200)

  grants.rows[DEVICE].scope = 'full'
  assert.equal((await fetch(url)).status, 403)
})

test('a device whose grant vanished entirely is refused', async (t) => {
  const rows = { [DEVICE]: okGrant() }
  const { casts, speakers, grants } = await build(rows)
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.x' })
  const url = urlOf(speakers)
  delete grants.rows[DEVICE]
  assert.equal((await fetch(url)).status, 403)
})

test('an unknown or malformed token is refused, and says nothing about why', async (t) => {
  const { casts, port } = await build({ [DEVICE]: okGrant() })
  t.after(() => casts.close())

  const bad = await fetch(`http://127.0.0.1:${port}/a/notarealtoken`)
  assert.equal(bad.status, 404)
  assert.equal(await bad.text(), '')
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/a/../../etc/passwd`)).status, 404)
})

test('stopFor SILENCES the speaker, not just the token - both halves of revoke', async (t) => {
  const { casts, speakers } = await build({ [DEVICE]: okGrant() })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.x' })
  const url = urlOf(speakers)
  speakers.calls.length = 0

  const stopped = await casts.stopFor(DEVICE)

  // 1. The speaker was actually told to stop. Without this the room keeps playing
  //    whatever HA and ffmpeg had already buffered.
  assert.equal(stopped, 1)
  assert.deepEqual(speakers.calls, [['stop', 'media_player.x']])
  // 2. And the token is gone, so nothing can re-fetch.
  assert.equal((await fetch(url)).status, 404)
  assert.deepEqual(casts.active(DEVICE), [])
})

test('stopFor silences EVERY entity a device started', async (t) => {
  const { casts, speakers } = await build({ [DEVICE]: okGrant() })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.a' })
  await casts.play({ deviceKey: DEVICE, trackId: 't2', entityId: 'media_player.b' })
  speakers.calls.length = 0

  assert.equal(await casts.stopFor(DEVICE), 2)
  assert.deepEqual(speakers.calls.map(c => c[1]).sort(), ['media_player.a', 'media_player.b'])
})

test('stopFor touches only the revoked device, and leaves other casts playing', async (t) => {
  const { casts, speakers } = await build({ [DEVICE]: okGrant(), [OTHER]: okGrant({ deviceKey: OTHER }) })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.a' })
  await casts.play({ deviceKey: OTHER, trackId: 't2', entityId: 'media_player.b' })
  speakers.calls.length = 0

  await casts.stopFor(DEVICE)
  assert.deepEqual(speakers.calls, [['stop', 'media_player.a']])
  assert.equal(casts.active(OTHER).length, 1)
})

test('a failed HA stop still drops the token, and is logged rather than swallowed', async (t) => {
  const { casts, speakers } = await build({ [DEVICE]: okGrant() })
  t.after(() => casts.close())
  const logged = []
  casts.log = (msg, data) => logged.push([msg, data])

  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.x' })
  const url = urlOf(speakers)
  speakers.stop = async () => { throw new Error('HA is down') }

  assert.equal(await casts.stopFor(DEVICE), 0)
  // The token must die even when we could not reach the speaker - otherwise a
  // dead HA would leave a revoked device able to keep pulling audio.
  assert.equal((await fetch(url)).status, 404)
  assert.ok(logged.some(([m]) => m === 'cast:stop-failed'))
})

test('deviceKeys() reports casting devices, so the expiry sweep can see them', async (t) => {
  const { casts } = await build({ [DEVICE]: okGrant() })
  t.after(() => casts.close())

  assert.deepEqual(casts.deviceKeys(), [])
  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.x' })
  assert.deepEqual(casts.deviceKeys(), [DEVICE])
})

test('re-playing on the same entity retires the old token', async (t) => {
  const { casts, speakers } = await build({ [DEVICE]: okGrant() })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.x' })
  const first = urlOf(speakers)
  speakers.calls.length = 0
  await casts.play({ deviceKey: DEVICE, trackId: 't2', entityId: 'media_player.x' })
  const second = urlOf(speakers)

  assert.notEqual(first, second)
  assert.equal((await fetch(first)).status, 404)
  assert.equal((await fetch(second)).status, 200)
  assert.equal(casts.active(DEVICE).length, 1)
})

test('a play HA refuses leaves no live token behind', async (t) => {
  const { casts, speakers } = await build({ [DEVICE]: okGrant() })
  t.after(() => casts.close())

  speakers.play = async () => { throw new Error('entity not found') }
  await assert.rejects(
    () => casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.gone' }),
    /entity not found/
  )
  assert.equal(casts.tokens.size, 0)
  assert.deepEqual(casts.active(DEVICE), [])
})

test('an expired token is refused even while the grant is perfectly good', async (t) => {
  const { casts, speakers } = await build({ [DEVICE]: okGrant() })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.x' })
  const url = urlOf(speakers)
  for (const entry of casts.tokens.values()) entry.expiresAt = Date.now() - 1
  assert.equal((await fetch(url)).status, 404)
})

test('close() silences every speaker it left playing', async (t) => {
  const { casts, speakers } = await build({ [DEVICE]: okGrant() })
  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.x' })
  speakers.calls.length = 0

  await casts.close()
  assert.deepEqual(speakers.calls, [['stop', 'media_player.x']])
})

// --- the loopback rule -------------------------------------------------
//
// Phase 1 refuses a Home Assistant that is not on this machine, because HA is the
// party that fetches the audio: a remote HA would mean publishing the library to
// the LAN, which is the expensive path this phase deliberately does not take.

test('isLoopbackUrl accepts every form of "this machine"', () => {
  for (const u of ['http://127.0.0.1:8123', 'http://localhost:8123', 'http://[::1]:8123',
    'https://127.0.0.1:8123', 'http://127.1.2.3:8123']) {
    assert.equal(isLoopbackUrl(u), true, u)
  }
})

test('isLoopbackUrl rejects anything else, including lookalikes', () => {
  for (const u of ['http://192.168.1.50:8123', 'http://homeassistant.local:8123',
    'http://10.0.0.5:8123', 'http://127.0.0.1.example.com:8123', 'ftp://127.0.0.1',
    'not a url', '', null]) {
    assert.equal(isLoopbackUrl(u), false, String(u))
  }
})

test('requireLoopback explains itself rather than just failing', () => {
  assert.equal(requireLoopback('http://127.0.0.1:8123'), null)
  const why = requireLoopback('http://192.168.1.50:8123')
  assert.match(why, /same machine/)
})

// --- voice control -----------------------------------------------------
//
// The token is the whole gate on this route, so every way of getting past it without one
// gets a test. The route lives on the loopback server, which the bind test above already
// pins to 127.0.0.1 - that is what stops the LAN reaching it at all.

const VOICE_KEY = 'voice-device-key'

async function buildVoice (over = {}) {
  const speakers = fakeSpeakers()
  speakers.config = {
    enabled: true,
    voiceEnabled: true,
    voiceToken: 'the-right-token',
    voiceKey: VOICE_KEY,
    voiceEntityId: 'media_player.default',
    ...over
  }
  const grants = fakeGrants({ [VOICE_KEY]: okGrant({ deviceKey: VOICE_KEY }) })
  // The real shape: search() answers { artists, albums, tracks }, which the first cut of
  // the voice code ignored in favour of tracks[0] - the reason "put on Led Zeppelin"
  // always got the same song.
  const LIB = {
    artists: [{ id: 'art1', name: 'Led Zeppelin' }],
    albums: [{ id: 'alb1', name: 'Physical Graffiti', artist: 'Led Zeppelin' }],
    tracks: [
      { id: 'trk1', title: 'Kashmir', artist: 'Led Zeppelin' },
      { id: 'trk2', title: 'Rock and Roll', artist: 'Led Zeppelin' },
      { id: 'trk3', title: 'Houses of the Holy', artist: 'Led Zeppelin' }
    ]
  }
  const adapter = {
    async stream () { return Readable.from([Buffer.from('AUDIOBYTES')]) },
    async get ({ id, type }) {
      if (type === 'album' && id === 'alb1') return { id, tracks: LIB.tracks }
      return null
    },
    async search ({ q }) {
      const want = q.toLowerCase()
      if (want.includes('metallica') || want === 'nothing here') return { artists: [], albums: [], tracks: [] }
      return {
        artists: LIB.artists.filter(a => a.name.toLowerCase().includes(want)),
        albums: LIB.albums.filter(a => a.name.toLowerCase().includes(want)),
        tracks: LIB.tracks.filter(t => t.title.toLowerCase().includes(want) || t.artist.toLowerCase().includes(want))
      }
    }
  }
  const casts = new CastSessions({ speakers, grants, getAdapter: () => adapter })
  const port = await casts.start()
  return { casts, speakers, grants, port }
}

const voicePost = (port, body) => fetch(`http://127.0.0.1:${port}/voice/play`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
})

test('an ARTIST request queues their music, not one song', async (t) => {
  const { casts, speakers, port } = await buildVoice()
  t.after(() => casts.close())

  const res = await voicePost(port, { token: 'the-right-token', query: 'led zeppelin', entityId: 'media_player.x' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.kind, 'artist')
  assert.equal(body.artist, 'Led Zeppelin')
  // THE BUG THIS PINS: the first cut played tracks[0] and stopped, so an artist was one
  // song on repeat-nothing. A queue is the whole point of asking for an artist.
  assert.equal(body.count, 3)
  assert.equal(casts.queues.get(VOICE_KEY).items.length, 3)
  assert.equal(speakers.calls.find(c => c[0] === 'play')[1], 'media_player.x')
})

test('a TRACK request plays THAT track first, not the artist\'s first song', async (t) => {
  const { casts, port } = await buildVoice()
  t.after(() => casts.close())

  const body = await (await voicePost(port, { token: 'the-right-token', query: 'rock and roll', entityId: 'e' })).json()
  assert.equal(body.kind, 'track')
  assert.equal(body.title, 'Rock and Roll')
  assert.equal(casts.queues.get(VOICE_KEY).items[0], 'trk2', 'the asked-for track leads')
  assert.ok(casts.queues.get(VOICE_KEY).items.length > 1, 'and it keeps going afterwards')
})

test('an ALBUM request plays the album', async (t) => {
  const { casts, port } = await buildVoice()
  t.after(() => casts.close())

  const body = await (await voicePost(port, { token: 'the-right-token', query: 'physical graffiti', entityId: 'e' })).json()
  assert.equal(body.kind, 'album')
  assert.equal(body.title, 'Physical Graffiti')
})

test('an artist we do NOT have is a clean, speakable miss', async (t) => {
  const { casts, speakers, port } = await buildVoice()
  t.after(() => casts.close())

  // Tim's exact report: asking for Metallica did nothing at all, and worse, left whatever
  // was already playing alone so it looked like the request had been ignored.
  const res = await voicePost(port, { token: 'the-right-token', query: 'metallica', entityId: 'e' })
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.error, 'not in the library')
  assert.equal(body.query, 'metallica', 'the query comes back so the response can name it')
  assert.equal(speakers.calls.length, 0)
})

test('the queue advances on its own when a track ends - nothing else can advance it', async (t) => {
  const { casts, speakers, port } = await buildVoice()
  t.after(() => casts.close())

  await voicePost(port, { token: 'the-right-token', query: 'led zeppelin', entityId: 'media_player.x' })
  assert.equal(casts.queues.get(VOICE_KEY).index, 0)

  // The speaker reports playing, then idle: exactly what a finished track looks like.
  speakers.states.set('media_player.x', { state: 'playing' })
  await casts._poll()
  speakers.states.set('media_player.x', { state: 'idle' })
  await casts._poll()

  assert.equal(casts.queues.get(VOICE_KEY).index, 1, 'moved to the next track by itself')
  assert.equal(speakers.calls.filter(c => c[0] === 'play').length, 2)
})

test('a voice request with the WRONG token is refused', async (t) => {
  const { casts, speakers, port } = await buildVoice()
  t.after(() => casts.close())

  assert.equal((await voicePost(port, { token: 'guessed', query: 'x', entityId: 'e' })).status, 403)
  assert.equal(speakers.calls.length, 0, 'nothing may reach the speaker')
})

test('a voice request with NO token is refused', async (t) => {
  const { casts, port } = await buildVoice()
  t.after(() => casts.close())
  assert.equal((await voicePost(port, { query: 'x', entityId: 'e' })).status, 403)
})

test('voice is refused entirely when it is switched off', async (t) => {
  const { casts, port } = await buildVoice({ voiceEnabled: false })
  t.after(() => casts.close())
  // 404, not 403: an off feature should not confirm that a token would have worked.
  assert.equal((await voicePost(port, { token: 'the-right-token', query: 'x', entityId: 'e' })).status, 404)
})

test('rotating the token invalidates the old one immediately', async (t) => {
  const { casts, speakers, port } = await buildVoice()
  t.after(() => casts.close())

  assert.equal((await voicePost(port, { token: 'the-right-token', query: 'a', entityId: 'e' })).status, 200)
  speakers.config.voiceToken = 'rotated'
  assert.equal((await voicePost(port, { token: 'the-right-token', query: 'a', entityId: 'e' })).status, 403)
  assert.equal((await voicePost(port, { token: 'rotated', query: 'a', entityId: 'e' })).status, 200)
})

test('a query that matches nothing says so, and plays nothing', async (t) => {
  const { casts, speakers, port } = await buildVoice()
  t.after(() => casts.close())

  const res = await voicePost(port, { token: 'the-right-token', query: 'nothing here', entityId: 'e' })
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'not in the library')
  assert.equal(speakers.calls.length, 0)
})

test('an empty query is refused rather than playing something arbitrary', async (t) => {
  const { casts, port } = await buildVoice()
  t.after(() => casts.close())
  assert.equal((await voicePost(port, { token: 'the-right-token', query: '   ', entityId: 'e' })).status, 400)
})

test('with no entityId it falls back to the configured default speaker', async (t) => {
  const { casts, speakers, port } = await buildVoice()
  t.after(() => casts.close())

  assert.equal((await voicePost(port, { token: 'the-right-token', query: 'a' })).status, 200)
  assert.equal(speakers.calls.find(c => c[0] === 'play')[1], 'media_player.default')
})

test('GET is refused - this route only accepts POST', async (t) => {
  const { casts, port } = await buildVoice()
  t.after(() => casts.close())
  assert.equal((await fetch(`http://127.0.0.1:${port}/voice/play`)).status, 405)
})

test('REVOKING the voice grant kills voice playback, same as any device', async (t) => {
  const { casts, grants, port } = await buildVoice()
  t.after(() => casts.close())

  const res = await voicePost(port, { token: 'the-right-token', query: 'a', entityId: 'e' })
  assert.equal(res.status, 200)
  const url = `http://127.0.0.1:${port}/a/${[...casts.tokens.keys()][0]}`
  assert.equal((await fetch(url)).status, 200)

  // The operator revokes "Home Assistant voice" on the Devices tab. No voice-specific
  // code runs here - it is the ordinary grant path, which is the point of giving voice a
  // real grant instead of a special case.
  grants.rows[VOICE_KEY].revokedAt = Date.now()
  assert.equal((await fetch(url)).status, 403)
})

// --- voice controls: next / previous / stop / shuffle -------------------

const voiceCtl = (port, body) => fetch(`http://127.0.0.1:${port}/voice/control`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
})

test('voice next and previous walk the HOST queue, not the speaker', async (t) => {
  const { casts, port } = await buildVoice()
  t.after(() => casts.close())

  await voicePost(port, { token: 'the-right-token', query: 'led zeppelin', entityId: 'media_player.x' })
  assert.equal(casts.queues.get(VOICE_KEY).index, 0)

  assert.equal((await voiceCtl(port, { token: 'the-right-token', action: 'next' })).status, 200)
  assert.equal(casts.queues.get(VOICE_KEY).index, 1)
  assert.equal((await voiceCtl(port, { token: 'the-right-token', action: 'previous' })).status, 200)
  assert.equal(casts.queues.get(VOICE_KEY).index, 0)
})

test('previous at the start and next at the end refuse rather than wrap', async (t) => {
  const { casts, port } = await buildVoice()
  t.after(() => casts.close())

  await voicePost(port, { token: 'the-right-token', query: 'led zeppelin', entityId: 'media_player.x' })
  assert.equal((await voiceCtl(port, { token: 'the-right-token', action: 'previous' })).status, 409)

  const q = casts.queues.get(VOICE_KEY)
  q.index = q.items.length - 1
  assert.equal((await voiceCtl(port, { token: 'the-right-token', action: 'next' })).status, 409)
})

test('voice stop ends the cast for real - token gone, speaker silenced', async (t) => {
  const { casts, speakers, port } = await buildVoice()
  t.after(() => casts.close())

  await voicePost(port, { token: 'the-right-token', query: 'led zeppelin', entityId: 'media_player.x' })
  const url = `http://127.0.0.1:${port}/a/${[...casts.tokens.keys()][0]}`
  speakers.calls.length = 0

  assert.equal((await voiceCtl(port, { token: 'the-right-token', action: 'stop' })).status, 200)
  assert.deepEqual(speakers.calls, [['stop', 'media_player.x']])
  assert.equal((await fetch(url)).status, 404, 'and nothing can be fetched afterwards')
  assert.equal(casts.queues.has(VOICE_KEY), false)
})

test('voice shuffle reorders what is COMING, and leaves the current track playing', async (t) => {
  const { casts, speakers, port } = await buildVoice()
  t.after(() => casts.close())

  await voicePost(port, { token: 'the-right-token', query: 'led zeppelin', entityId: 'media_player.x' })
  const q = casts.queues.get(VOICE_KEY)
  const playing = q.items[q.index]
  speakers.calls.length = 0

  assert.equal((await voiceCtl(port, { token: 'the-right-token', action: 'shuffle' })).status, 200)
  assert.equal(casts.queues.get(VOICE_KEY).items[q.index], playing, 'the current track is untouched')
  assert.equal(casts.queues.get(VOICE_KEY).items.length, 3, 'and nothing is lost')
  assert.equal(speakers.calls.length, 0, 'shuffling must not restart the music')
})

test('the controls are behind the same token as everything else', async (t) => {
  const { casts, port } = await buildVoice()
  t.after(() => casts.close())
  assert.equal((await voiceCtl(port, { token: 'guessed', action: 'next' })).status, 403)
  assert.equal((await voiceCtl(port, { action: 'stop' })).status, 403)
})

test('a control with nothing playing says so rather than erroring', async (t) => {
  const { casts, port } = await buildVoice()
  t.after(() => casts.close())
  assert.equal((await voiceCtl(port, { token: 'the-right-token', action: 'next' })).status, 409)
})

test('an unknown action is refused', async (t) => {
  const { casts, port } = await buildVoice()
  t.after(() => casts.close())
  await voicePost(port, { token: 'the-right-token', query: 'led zeppelin', entityId: 'e' })
  assert.equal((await voiceCtl(port, { token: 'the-right-token', action: 'rm -rf' })).status, 400)
})

// --- pause / resume ----------------------------------------------------
//
// These exist so the player's play/pause button has something to drive while casting.
// Before them it fell through to the phone and started a second copy of the song.

test('pause and resume reach the speaker, and do not disturb the token', async (t) => {
  const { casts, speakers } = await build({ [DEVICE]: okGrant() })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, trackId: 't1', entityId: 'media_player.x' })
  const url = urlOf(speakers)
  speakers.calls.length = 0

  await speakers.pause('media_player.x')
  await speakers.resume('media_player.x')
  assert.deepEqual(speakers.calls, [['pause', 'media_player.x'], ['resume', 'media_player.x']])
  // A pause is not a revoke: the cast is still live and still fetchable.
  assert.equal((await fetch(url)).status, 200)
  assert.equal(casts.active(DEVICE).length, 1)
})

// --- config persistence ------------------------------------------------
//
// Found on the first hardware run: the dashboard showed a ticked box while the
// phone was told the feature was off, because a partial save had silently written
// enabled:false. An absent field must mean "leave it alone".

const os = require('os')
const fspromises = require('fs')

function tmpSpeakers () {
  const dir = fspromises.mkdtempSync(path.join(os.tmpdir(), 'pt-speakers-'))
  return { dir, make: () => new Speakers({ dataDir: dir }) }
}

test('an absent `enabled` on save does NOT turn the feature off', () => {
  const { make } = tmpSpeakers()
  const s = make()
  s.save({ enabled: true, baseUrl: 'http://127.0.0.1:8123', token: 'tok' })
  assert.equal(s.enabled, true)

  // A partial update - say a future caller that only means to move the address.
  s.save({ baseUrl: 'http://127.0.0.1:9999' })
  assert.equal(s.config.enabled, true, 'enabled must survive a save that omits it')
  assert.equal(s.config.baseUrl, 'http://127.0.0.1:9999')
})

test('an explicit enabled:false still turns it off', () => {
  const { make } = tmpSpeakers()
  const s = make()
  s.save({ enabled: true, baseUrl: 'http://127.0.0.1:8123', token: 'tok' })
  s.save({ enabled: false })
  assert.equal(s.enabled, false)
})

test('an empty token means keep the stored one, not erase it', () => {
  const { make } = tmpSpeakers()
  const s = make()
  s.save({ enabled: true, baseUrl: 'http://127.0.0.1:8123', token: 'secret' })
  s.save({ enabled: true, baseUrl: 'http://127.0.0.1:8123', token: '' })
  assert.equal(s.config.token, 'secret')
  assert.equal(s.enabled, true)
})

test('the config survives a reload from disk', () => {
  const { make } = tmpSpeakers()
  make().save({ enabled: true, baseUrl: 'http://127.0.0.1:8123', token: 'tok' })
  const fresh = make()
  assert.equal(fresh.enabled, true, 'a restart must not lose the operator setting')
})

test('enabling with a non-loopback address is refused, with the reason', () => {
  const { make } = tmpSpeakers()
  const s = make()
  assert.throws(
    () => s.save({ enabled: true, baseUrl: 'http://192.168.1.50:8123', token: 'tok' }),
    /same machine/
  )
  assert.equal(s.enabled, false)
})

test('enabling with no token is refused', () => {
  const { make } = tmpSpeakers()
  const s = make()
  assert.throws(() => s.save({ enabled: true, baseUrl: 'http://127.0.0.1:8123' }), /token/)
})

test('publicConfig never leaks the token, only whether one is set', () => {
  const { make } = tmpSpeakers()
  const s = make()
  s.save({ enabled: true, baseUrl: 'http://127.0.0.1:8123', token: 'super-secret' })
  const pub = s.publicConfig()
  assert.equal(pub.tokenSet, true)
  assert.equal(pub.token, undefined)
  assert.equal(JSON.stringify(pub).includes('super-secret'), false)
})
