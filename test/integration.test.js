// End-to-end over a HyperDHT testnet: a real host, a real client, real
// connections, no mocks.
//
// The revoke-mid-stream test is the reason this project exists. Everything else
// here is table stakes for a music player; that one is the thing holesail cannot
// do and the thing we would be embarrassed to get wrong.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const Protomux = require('protomux')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const z32 = require('z32')

const { PearTuneHost } = require('../host/server')
const { PearTuneClient } = require('../client')
const { parseLink } = require('../protocol/link')
const { libraryId } = require('../protocol/ids')
const { PAIR_PROTOCOL } = require('../protocol/constants')
const framing = require('../protocol/framing')

const QUIET = () => {}

// A recognisable "track": big enough to span many 64 KiB frames, so a revoke
// mid-stream lands in the middle of a real transfer rather than after it.
const TRACK_BYTES = 3 * 1024 * 1024

async function scaffold (t) {
  const testnet = await createTestnet(3)
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'peartune-'))
  const musicDir = path.join(dir, 'music')
  await fsp.mkdir(musicDir, { recursive: true })

  const track = b4a.alloc(TRACK_BYTES)
  for (let i = 0; i < track.length; i++) track[i] = i % 251 // non-repeating-ish
  await fsp.writeFile(path.join(musicDir, 'test-track.flac'), track)

  const host = new PearTuneHost({
    dataDir: path.join(dir, 'host-data'),
    musicDir,
    libraryName: 'Test Library',
    bootstrap: testnet.bootstrap,
    log: QUIET
  })
  await host.ready()

  t.after(async () => {
    await host.close()
    await testnet.destroy()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  return { testnet, host, track, dir }
}

function newClient (testnet) {
  return new PearTuneClient({
    keyPair: hcrypto.keyPair(),
    bootstrap: testnet.bootstrap,
    log: QUIET
  })
}

async function pairAndConnect (testnet, host) {
  const client = newClient(testnet)
  const link = host.startPairing()
  const paired = await client.pair(link, { label: 'test-phone', platform: 'android' })
  await client.connect({ hostKey: paired.hostKey, libraryId: paired.libraryId })
  return { client, paired }
}

test('pair by QR link, then reach the library', async (t) => {
  const { testnet, host, track } = await scaffold(t)

  const { client, paired } = await pairAndConnect(testnet, host)
  t.after(() => client.close())

  assert.equal(paired.libraryId, host.libraryId)
  assert.equal(paired.libraryName, 'Test Library')

  const pong = await client.ping()
  assert.equal(pong.protocol, 1)
  assert.equal(pong.libraryId, host.libraryId)

  const stats = await client.stats()
  assert.equal(stats.source, 'folder')
  assert.equal(stats.tracks, 1)

  const { items } = await client.list({ type: 'tracks' })
  assert.equal(items.length, 1)
  assert.equal(items[0].size, track.length)

  // The grant exists, and it is keyed to the phone's REAL public key.
  const devices = await host.listDevices()
  assert.equal(devices.length, 1)
  assert.equal(devices[0].deviceKey, z32.encode(client.keyPair.publicKey))
  assert.equal(devices[0].label, 'test-phone')
  assert.equal(devices[0].revokedAt, null)
})

// --- favorites (host-as-hub, milestone 3) -----------------------------------

test('favorites: set track/album, list back grouped, toggle off - over the real connection', async (t) => {
  const { testnet, host } = await scaffold(t)
  const { client } = await pairAndConnect(testnet, host)
  t.after(() => client.close())

  const { items } = await client.list({ type: 'tracks' })
  const id = items[0].id

  assert.deepEqual(await client.favList(), { track: [], album: [], artist: [] })

  // A track (default kind) and an album, to prove the kinds are independent.
  const r = await client.favSet({ id, on: true })
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'track')
  await client.favSet({ kind: 'album', id: 'album-99', on: true })

  assert.deepEqual(await client.favList(), { track: [id], album: ['album-99'], artist: [] })

  await client.favSet({ id, on: false })
  assert.deepEqual(await client.favList(), { track: [], album: ['album-99'], artist: [] })
})

test('favorites are the DEVICE\'s: a second unclaimed device does not see them', async (t) => {
  const { testnet, host } = await scaffold(t)
  const a = await pairAndConnect(testnet, host)
  const b = await pairAndConnect(testnet, host)
  t.after(() => a.client.close())
  t.after(() => b.client.close())

  const { items } = await a.client.list({ type: 'tracks' })
  await a.client.favSet({ id: items[0].id, on: true })

  // B is a different device with no person assigned, so it is a different owner and
  // sees nothing of A's. The owner came from A's Noise-authenticated connection - B
  // could not have set it as A even if it tried (there is no owner param to send).
  assert.deepEqual((await b.client.favList()).track, [], 'per-owner isolation over the wire')
})

// --- playlists (host-as-hub, milestone 3, phase 4) --------------------------

test('playlists: create, add, reorder/remove, rename, delete - over the real connection', async (t) => {
  const { testnet, host } = await scaffold(t)
  const { client } = await pairAndConnect(testnet, host)
  t.after(() => client.close())

  assert.deepEqual((await client.playlistList()).items, [], 'no playlists yet')

  const pl = await client.playlistCreate({ name: 'Roadtrip' })
  assert.ok(pl.id, 'the host mints the id')
  assert.equal(pl.name, 'Roadtrip')

  // Append, skipping duplicates: 't2' is already in the list, so only 't3' lands.
  await client.playlistAdd({ id: pl.id, trackIds: ['t1', 't2'] })
  const add2 = await client.playlistAdd({ id: pl.id, trackIds: ['t2', 't3'] })
  assert.equal(add2.count, 3)
  assert.equal(add2.added, 1, 'only the new track counts as added')
  assert.deepEqual((await client.playlistGet({ id: pl.id })).trackIds, ['t1', 't2', 't3'])

  // The list view carries a count and the name.
  assert.deepEqual((await client.playlistList()).items.map(p => [p.name, p.count]), [['Roadtrip', 3]])

  // Reorder + remove is one setTracks call (the app sends the new order).
  await client.playlistSetTracks({ id: pl.id, trackIds: ['t3', 't1'] })
  assert.deepEqual((await client.playlistGet({ id: pl.id })).trackIds, ['t3', 't1'])

  const rn = await client.playlistRename({ id: pl.id, name: 'Summer' })
  assert.equal(rn.name, 'Summer')

  await client.playlistDelete({ id: pl.id })
  assert.deepEqual((await client.playlistList()).items, [], 'gone after delete')
})

test('a playlist is the DEVICE\'s: a second unclaimed device cannot see or touch it', async (t) => {
  const { testnet, host } = await scaffold(t)
  const a = await pairAndConnect(testnet, host)
  const b = await pairAndConnect(testnet, host)
  t.after(() => a.client.close())
  t.after(() => b.client.close())

  const pl = await a.client.playlistCreate({ name: 'private' })

  // B is a different owner: it sees none of A's playlists...
  assert.deepEqual((await b.client.playlistList()).items, [], 'per-owner isolation over the wire')
  // ...and cannot reach A's even knowing its id - the host keys by the connection's owner.
  await assert.rejects(() => b.client.playlistGet({ id: pl.id }), /no such playlist/)
  await assert.rejects(() => b.client.playlistRename({ id: pl.id, name: 'hijack' }), /no such playlist/)
  // A's playlist is untouched.
  assert.equal((await a.client.playlistList()).items[0].name, 'private')
})

// --- session handoff: instant presence (proposal 2026-07-17, follow-up #1) ---

// Pair two devices, assign BOTH to one person (so they share a session owner), then connect.
// Assignment must precede connect: the grant - and the owner derived from it - is captured at
// connect time, so a device assigned after connecting would still own state as itself.
async function twoDevicesOnePerson (testnet, host, name = 'Tim') {
  const aClient = newClient(testnet)
  const bClient = newClient(testnet)
  const linkA = host.startPairing()
  const pairedA = await aClient.pair(linkA, { label: 'Phone', platform: 'android' })
  const linkB = host.startPairing()
  const pairedB = await bClient.pair(linkB, { label: 'Tablet', platform: 'android' })

  const person = await host.grants.addPerson(name)
  await host.grants.assign(z32.encode(aClient.keyPair.publicKey), person.id)
  await host.grants.assign(z32.encode(bClient.keyPair.publicKey), person.id)

  await aClient.connect({ hostKey: pairedA.hostKey, libraryId: pairedA.libraryId })
  await bClient.connect({ hostKey: pairedB.hostKey, libraryId: pairedB.libraryId })
  // Shaped like pairAndConnect ({ client, ... }) so the tests read a.client / b.client.
  return { a: { client: aClient }, b: { client: bClient } }
}

// Resolve when `client` receives a push of `kind`, preserving any handler already set.
function oncePush (client, kind, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no push: ' + kind)), ms)
    if (timer.unref) timer.unref()
    const prev = client.onPush
    client.onPush = (m) => {
      if (prev) { try { prev(m) } catch {} }
      if (m && m.kind === kind) { clearTimeout(timer); resolve(m) }
    }
  })
}

test('HANDOFF: claiming the session pushes "superseded" to the device that held it (instant presence)', async (t) => {
  const { testnet, host } = await scaffold(t)
  const { a, b } = await twoDevicesOnePerson(testnet, host)
  t.after(() => a.client.close())
  t.after(() => b.client.close())

  // A becomes the active player and mirrors a queue + its exact spot.
  const c0 = await a.client.sessionGet()
  const claimedA = await a.client.sessionClaim({ generation: c0?.generation || 0 })
  assert.equal(claimedA.ok, true)
  await a.client.sessionSet({ queue: [{ trackId: 't1' }, { trackId: 't2' }], index: 1, positionMs: 42000, playing: true })

  // B reads the session (same owner, so it SEES A's) and "Play here".
  const seen = await b.client.sessionGet()
  assert.equal(seen.isActiveHere, false)
  assert.equal(seen.activeDeviceName, 'Phone')
  assert.equal(seen.playing, true)           // the card would read "Playing on Phone"
  assert.equal(seen.queue.length, 2)

  // The claim must push "superseded" to A. Arm the listener BEFORE claiming so we cannot miss it.
  const pushed = oncePush(a.client, 'session-superseded')
  const claimedB = await b.client.sessionClaim({ generation: seen.generation })
  assert.equal(claimedB.ok, true)
  assert.equal(claimedB.session.positionMs, 42000, 'B adopts the exact spot from the claim reply')
  assert.equal(claimedB.session.index, 1)

  const evt = await pushed
  assert.equal(evt.data.generation, claimedB.session.generation, 'the push carries the winning generation')

  // The push is the fast path; the lazy backstop still holds - A, now superseded, is refused if
  // it writes (ok:false, which is how it would have learned lazily without the push).
  const rejected = await a.client.sessionSet({ queue: [{ trackId: 'x' }], index: 0 })
  assert.equal(rejected.ok, false, 'a superseded device cannot overwrite the session')
  const after = await b.client.sessionGet()
  assert.equal(after.isActiveHere, true, 'B holds the token')
})

test('HANDOFF: an idempotent re-claim by the current holder pushes nobody', async (t) => {
  const { testnet, host } = await scaffold(t)
  const { a, b } = await twoDevicesOnePerson(testnet, host)
  t.after(() => a.client.close())
  t.after(() => b.client.close())

  const c0 = await a.client.sessionGet()
  const claimed = await a.client.sessionClaim({ generation: c0?.generation || 0 })

  // A re-claims with the CURRENT generation (it still holds the token). No prior holder changed,
  // so B must not be told anything. Assert B gets no push within a short window.
  let bGotPush = false
  b.client.onPush = () => { bGotPush = true }
  await a.client.sessionClaim({ generation: claimed.session.generation })
  await new Promise(r => setTimeout(r, 500))
  assert.equal(bGotPush, false, 'a self re-claim supersedes nobody')
})

test('stream a whole track, bytes identical to the file on disk', async (t) => {
  const { testnet, host, track } = await scaffold(t)
  const { client } = await pairAndConnect(testnet, host)
  t.after(() => client.close())

  const { items } = await client.list({ type: 'tracks' })
  const body = await client.stream({ trackId: items[0].id })

  assert.equal(body.length, track.length)
  assert.ok(b4a.equals(body, track), 'streamed bytes must match the source file exactly')
})

test('range request returns the correct slice (this is what makes seeking work)', async (t) => {
  const { testnet, host, track } = await scaffold(t)
  const { client } = await pairAndConnect(testnet, host)
  t.after(() => client.close())

  const { items } = await client.list({ type: 'tracks' })
  const id = items[0].id

  const offset = 1_000_000
  const length = 50_000
  const slice = await client.stream({ trackId: id, offset, length })

  assert.equal(slice.length, length)
  assert.ok(b4a.equals(slice, track.subarray(offset, offset + length)), 'range must match the same window of the file')

  // A tail read (no length) runs to EOF - the resumable-download case.
  const tail = await client.stream({ trackId: id, offset: track.length - 10 })
  assert.equal(tail.length, 10)
  assert.ok(b4a.equals(tail, track.subarray(track.length - 10)))
})

test('an unpaired device is REFUSED by the firewall', async (t) => {
  const { testnet, host } = await scaffold(t)

  const stranger = newClient(testnet)
  t.after(() => stranger.close())

  // Never paired, so no grant exists. It knows the host key (it is public) but
  // that must not be enough.
  await assert.rejects(
    withTimeout(stranger.connect({ hostKey: host.publicKey, libraryId: host.libraryId }), 4000),
    'a device with no grant must not be able to open a connection'
  )
})

test('HEADLINE: revoke kills the music mid-stream, and denies reconnect', async (t) => {
  const { testnet, host } = await scaffold(t)
  const { client } = await pairAndConnect(testnet, host)
  t.after(() => client.close())

  const { items } = await client.list({ type: 'tracks' })
  const id = items[0].id
  const deviceKey = z32.encode(client.keyPair.publicKey)

  assert.equal(host.connections.count(deviceKey), 1, 'the live connection must be registered')

  // Start a real transfer, then pull the rug halfway through it.
  let received = 0
  let revoked = false
  const playback = client.stream({ trackId: id }, (chunk) => {
    received += chunk.length
    // Revoke once the stream is genuinely in flight, not before it starts.
    if (!revoked && received > 256 * 1024) {
      revoked = true
      host.revokeDevice(deviceKey)
    }
  })

  // The in-flight request must FAIL, not hang and not quietly complete. A
  // revoked device finishing its song is exactly the bug this design exists to
  // prevent.
  await assert.rejects(
    withTimeout(playback, 5000),
    'the in-flight stream must die when the device is revoked'
  )

  assert.ok(revoked, 'the test must actually have revoked mid-stream')
  assert.ok(received > 0, 'some audio must have flowed before the revoke')
  assert.ok(received < TRACK_BYTES, `the stream must NOT have completed (got ${received} of ${TRACK_BYTES})`)
  assert.equal(host.connections.count(deviceKey), 0, 'the killed connection must be deregistered')

  // And it stays out: the grant is tombstoned, so the firewall refuses the
  // reconnect too.
  const again = new PearTuneClient({
    keyPair: client.keyPair, // same device identity
    bootstrap: testnet.bootstrap,
    log: QUIET
  })
  t.after(() => again.close())

  await assert.rejects(
    withTimeout(again.connect({ hostKey: host.publicKey, libraryId: host.libraryId }), 4000),
    'a revoked device must not be able to reconnect'
  )

  const devices = await host.listDevices()
  assert.ok(devices[0].revokedAt, 'the grant must be tombstoned, not deleted')
  assert.equal(devices[0].online, false)
})

test('revoking one device does not disturb another', async (t) => {
  const { testnet, host, track } = await scaffold(t)

  const a = await pairAndConnect(testnet, host)
  const b = await pairAndConnect(testnet, host)
  t.after(() => a.client.close())
  t.after(() => b.client.close())

  const { items } = await client_list(a.client)
  const id = items[0].id

  const aKey = z32.encode(a.client.keyPair.publicKey)
  await host.revokeDevice(aKey)

  // B was never touched and must still be able to play the whole track.
  const body = await b.client.stream({ trackId: id })
  assert.equal(body.length, track.length, 'the untouched device must still stream fine')
  assert.ok(b4a.equals(body, track))

  const devices = await host.listDevices()
  const bRow = devices.find(d => d.deviceKey === z32.encode(b.client.keyPair.publicKey))
  assert.equal(bRow.revokedAt, null, 'the bystander grant must be untouched')
})

// A hand-rolled client that speaks the pairing protocol but can lie in its hello.
// Used for the two attack tests below.
async function forgedPair (testnet, host, link, { deviceKey, rv }) {
  const { hostKey } = parseLink(link)
  const libId = libraryId(hostKey)
  const attacker = hcrypto.keyPair()

  const dht = new HyperDHT({ bootstrap: testnet.bootstrap })
  const conn = dht.connect(hostKey, { keyPair: attacker })
  conn.on('error', () => {})

  const hungUp = new Promise((resolve) => conn.once('close', () => resolve(true)))

  try {
    await withTimeout(conn.opened, 8000)
    const mux = Protomux.from(conn)
    const channel = mux.createChannel({ protocol: PAIR_PROTOCOL, id: b4a.from(libId) })
    const hello = channel.addMessage({ encoding: framing.deviceHello })
    channel.open()
    hello.send({
      rv: rv ?? parseLink(link).rv,
      deviceKey: deviceKey ?? attacker.publicKey,
      label: 'impostor',
      platform: 'android'
    })
    await withTimeout(hungUp, 8000)
  } finally {
    conn.destroy()
    await dht.destroy()
  }
}

test('ATTACK: pairing as someone else (forged deviceKey) is rejected', async (t) => {
  const { testnet, host } = await scaffold(t)

  // The hello claims a device key the attacker does not hold. Noise has already
  // proven its REAL key to the host, so the claim contradicts the proof.
  //
  // Without this check an attacker could mint a grant for a key whose owner
  // never consented, or inherit a victim's existing grant.
  const victimKey = hcrypto.keyPair().publicKey
  const link = host.startPairing()

  await forgedPair(testnet, host, link, { deviceKey: victimKey })

  const devices = await host.listDevices()
  assert.equal(devices.length, 0, 'no grant may be written for a forged hello')
})

test('ATTACK: pairing without the QR token is rejected', async (t) => {
  const { testnet, host } = await scaffold(t)

  // The host key is an ADDRESS, not a secret - anyone who has ever seen it can
  // dial the host. So dialing must not be sufficient to pair. Only the one-time
  // `rv` from the QR the operator is holding proves the device is standing in
  // front of that screen.
  const link = host.startPairing()

  await forgedPair(testnet, host, link, { rv: hcrypto.randomBytes(32) })

  const devices = await host.listDevices()
  assert.equal(devices.length, 0, 'a wrong pairing token must not produce a grant')
})

test('a pairing window that is CLOSED admits nobody', async (t) => {
  const { testnet, host } = await scaffold(t)

  const client = newClient(testnet)
  t.after(() => client.close())

  const link = host.startPairing()
  host.stopPairing() // operator closed the dashboard

  await assert.rejects(
    withTimeout(client.pair(link, { timeout: 3000 }), 6000),
    'no device may pair once the window is closed'
  )

  const devices = await host.listDevices()
  assert.equal(devices.length, 0)
})

// --- helpers ----------------------------------------------------------------

function client_list (client) {
  return client.list({ type: 'tracks' })
}

function withTimeout (promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref?.())
  ])
}

// --- library rename push (instant relabel, follow-up to the on-connect sync) ----

test('RENAME: setLibraryName pushes "library-renamed" to a connected device', async (t) => {
  const { testnet, host } = await scaffold(t)
  const { client, paired } = await pairAndConnect(testnet, host)
  t.after(() => client.close())

  // A round-trip first, so the host has finished opening the media channel and REGISTERED this
  // connection in the presence registry (connect() resolves client-side before that host-side work).
  await client.ping()

  // Arm the listener BEFORE renaming so we cannot miss the push.
  const pushed = oncePush(client, 'library-renamed')
  const clean = host.setLibraryName('Tim’s Umbrel')
  assert.equal(clean, 'Tim’s Umbrel')

  const evt = await pushed
  assert.equal(evt.data.libraryName, 'Tim’s Umbrel')
  // Self-describing: the push carries the libraryId so a device updates the RIGHT host record -
  // it works for a non-active pool host exactly as for the active one.
  assert.equal(evt.data.libraryId, host.libraryId)
  assert.equal(evt.data.libraryId, paired.libraryId)

  // The push is the FAST path, not the only one: identity.get still hands back the current name,
  // so a device offline during the rename catches up on its next connect.
  const id = await client.getIdentity()
  assert.equal(id.libraryName, 'Tim’s Umbrel')
})

test('RENAME: setting the SAME name pushes nobody (no spurious relabel)', async (t) => {
  const { testnet, host } = await scaffold(t)
  const { client } = await pairAndConnect(testnet, host)
  t.after(() => client.close())

  let pushes = 0
  client.onPush = (m) => { if (m?.kind === 'library-renamed') pushes++ }
  host.setLibraryName('Test Library') // scaffold's existing name - unchanged
  await new Promise((r) => { const tm = setTimeout(r, 200); if (tm.unref) tm.unref() })
  assert.equal(pushes, 0)
})

// --- dashboard now-playing (per-device, off the play session) ----------------

test('listDevices surfaces now-playing on the active device only, with a coverId', async (t) => {
  const { testnet, host } = await scaffold(t)
  const { client } = await pairAndConnect(testnet, host)
  t.after(() => client.close())

  const deviceKey = z32.encode(client.keyPair.publicKey)
  const ownerId = 'd:' + deviceKey // an unclaimed device is its own owner
  const { items } = await client.list({ type: 'tracks' })
  const track = items[0]

  // No session yet -> nothing playing, even though the device is connected.
  let me = (await host.listDevices()).find(d => d.deviceKey === deviceKey)
  assert.equal(me.nowPlaying, null)

  // Claim the session for THIS device and report a track.
  await host.userState.claimSession(ownerId, deviceKey, 0)
  await host.userState.setSession(ownerId, deviceKey, {
    queue: [{ trackId: track.id, title: 'Test Song', artist: 'Test Artist', durationMs: 1000 }],
    index: 0, shuffle: false, repeat: 0, positionMs: 0, playing: true
  })

  me = (await host.listDevices()).find(d => d.deviceKey === deviceKey)
  assert.ok(me.nowPlaying, 'the active device carries now-playing')
  assert.equal(me.nowPlaying.title, 'Test Song')
  assert.equal(me.nowPlaying.artist, 'Test Artist')
  assert.equal(me.nowPlaying.playing, true)
  assert.ok(me.nowPlaying.coverId, 'a coverId is resolved for the /api/art thumbnail')
})

// --- scheduled auto-rescan (host setting + timer) ----------------------------

test('scheduled rescan: persists, clamps, arms a timer, and shares library.json without clobber', async (t) => {
  const { host } = await scaffold(t)

  assert.equal(host.getRescanIntervalMin(), 0) // default off
  assert.equal(host._rescanTimer ?? null, null)

  assert.equal(host.setRescanIntervalMin(30), 30)
  assert.equal(host.getRescanIntervalMin(), 30)
  assert.ok(host._rescanTimer, 'a positive interval arms the timer')

  // name and interval share library.json - neither write may wipe the other.
  host.setLibraryName('My Music')
  assert.equal(host.getRescanIntervalMin(), 30, 'setLibraryName kept the interval')
  host.setRescanIntervalMin(60)
  assert.equal(host._readSettings().name, 'My Music', 'setRescanIntervalMin kept the name')

  // clamps out of range, and off disarms.
  assert.equal(host.setRescanIntervalMin(99999), 1440)
  assert.equal(host.setRescanIntervalMin(-5), 0)
  assert.equal(host._rescanTimer, null, 'off clears the timer')
})

// --- device avatars (set by the device, over the identity channel) -----------

test('a device sets and clears its own avatar over the wire, stored per deviceKey', async (t) => {
  const { testnet, host } = await scaffold(t)
  const { client } = await pairAndConnect(testnet, host)
  t.after(() => client.close())

  const deviceKey = z32.encode(client.keyPair.publicKey)
  assert.equal(host.avatars.has(deviceKey), false)

  const bytes = Buffer.from('pretend-jpeg-bytes')
  await client.setAvatar({ avatar: bytes.toString('base64') })
  assert.equal(host.avatars.has(deviceKey), true)
  assert.deepEqual(host.avatars.get(deviceKey), bytes)

  // it surfaces on the dashboard device list
  const dev = (await host.listDevices()).find(d => d.deviceKey === deviceKey)
  assert.equal(dev.hasAvatar, true)

  // an empty avatar clears it
  await client.setAvatar({ avatar: '' })
  assert.equal(host.avatars.has(deviceKey), false)
})
