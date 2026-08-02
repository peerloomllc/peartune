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
