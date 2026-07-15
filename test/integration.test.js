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
