// The host runs on @peerloom/host; the phone still speaks peartune/protocol. These
// pin that the two still agree, byte for byte, on what a paired phone already holds
// (proposals/2026-09-17-peartune-host-migration-plan.md in the suite root).
//
// integration.test.js proves the whole path works. This file pins the details a
// working path can still get wrong silently: an error message a phone matches on, a
// ping body with a new field, a mutating method missing from the readonly list, a
// method the phone calls that the table no longer answers.

const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const createTestnet = require('hyperdht/testnet')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const c = require('compact-encoding')
const z32 = require('z32')

const { PearTuneHost, PROTOCOL } = require('../host/server')
const { PearTuneClient } = require('../client')
const { MUTATING, METHODS } = require('../host/media')
const pkg = require('@peerloom/host')

const phone = {
  constants: require('../protocol/constants'),
  framing: require('../protocol/framing'),
  ids: require('../protocol/ids'),
  link: require('../protocol/link')
}

const QUIET = () => {}

async function scaffold (t) {
  const testnet = await createTestnet(3)
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'peartune-wire-'))
  const musicDir = path.join(dir, 'music')
  await fsp.mkdir(path.join(musicDir, 'Kids'), { recursive: true })
  await fsp.writeFile(path.join(musicDir, 'Kids', 'lullaby.mp3'), b4a.alloc(4096, 1))
  await fsp.writeFile(path.join(musicDir, 'rock.mp3'), b4a.alloc(4096, 2))
  const host = new PearTuneHost({ dataDir: path.join(dir, 'host-data'), musicDir, libraryName: 'Wire Library', bootstrap: testnet.bootstrap, log: QUIET })
  await host.ready()
  t.after(async () => {
    await host.close()
    await testnet.destroy()
    await fsp.rm(dir, { recursive: true, force: true })
  })
  return { testnet, host }
}

async function connectAs (t, testnet, host, grant = null) {
  const client = new PearTuneClient({ keyPair: hcrypto.keyPair(), bootstrap: testnet.bootstrap, log: QUIET })
  t.after(() => client.close())
  if (grant) {
    await host.grants.grant({ deviceKey: client.keyPair.publicKey, ...grant })
    await client.connect({ hostKey: host.publicKey, libraryId: host.libraryId })
  } else {
    const paired = await client.pair(host.startPairing(), { label: 'phone', platform: 'android' })
    await client.connect({ hostKey: paired.hostKey, libraryId: paired.libraryId })
  }
  return client
}

const errOf = (p) => p.then(() => null, (e) => ({ code: e.code, message: e.message }))

// --- the protocol the phone holds vs the one the host now speaks ----------------

test('constants, ids and links agree between peartune/protocol and @peerloom/host', () => {
  const k = phone.constants
  const p = PROTOCOL
  for (const name of ['PAIR_PROTOCOL', 'MEDIA_PROTOCOL', 'LINK_SCHEME', 'LINK_VERSION', 'PAIR_TTL_MS', 'CHUNK_SIZE']) {
    assert.deepEqual(p[name], k[name], name)
  }
  assert.deepEqual(p.ERR, k.ERR)
  assert.deepEqual(p.SCOPE, k.SCOPE)

  const hostKey = hcrypto.keyPair().publicKey
  const lib = phone.ids.libraryId(hostKey)
  assert.equal(PROTOCOL.ids.libraryId(hostKey), lib)
  assert.equal(PROTOCOL.ids.trackId(lib, 'folder', 'a/b.flac'), phone.ids.trackId(lib, 'folder', 'a/b.flac'))
  assert.equal(PROTOCOL.ids.groupId(lib, 'folder', 'album', 'x'), phone.ids.groupId(lib, 'folder', 'album', 'x'))
  assert.ok(b4a.equals(PROTOCOL.ids.hostTopic(hostKey), phone.ids.hostTopic(hostKey)))

  const rv = hcrypto.randomBytes(32)
  const opts = { hostKey, rv, name: 'Den', owner: true }
  const link = PROTOCOL.link.encodeLink(opts)
  assert.equal(link, phone.link.encodeLink(opts))
  assert.deepEqual(phone.link.parseLink(link), PROTOCOL.link.parseLink(link))
})

test('every frame encodes to the same bytes in both framings', () => {
  const samples = {
    req: { id: 7, method: 'library.list', params: { type: 'tracks', offset: 10 } },
    res: { id: 7, body: { items: [{ id: 'x', title: 'Ünïcode' }] } },
    chunk: { id: 7, seq: 3, data: b4a.from('bytes') },
    end: { id: 7, total: 12345 },
    err: { id: 7, code: 'ENOTFOUND', message: 'no such track' },
    push: { kind: 'grant:changed', data: { personId: null } },
    cancel: { id: 7 },
    deviceHello: { rv: hcrypto.randomBytes(32), deviceKey: hcrypto.randomBytes(32), label: 'phone', platform: 'android' },
    paired: { hostKey: z32.encode(hcrypto.randomBytes(32)), libraryId: 'lib', libraryName: 'Den' }
  }
  for (const [name, value] of Object.entries(samples)) {
    const a = c.encode(phone.framing[name], value)
    const b = c.encode(pkg.framing[name], value)
    assert.ok(b4a.equals(a, b), `${name} encodes differently`)
  }
})

// --- what the phone calls, and what the host answers ---------------------------

test('every method the phone client calls is answered by the table or the package', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'client', 'index.js'), 'utf8')
  const called = [...new Set([...src.matchAll(/_request\('([a-zA-Z.]+)'/g)].map((m) => m[1]))]
  const answered = new Set([...METHODS, 'ping', 'media.stream'])
  assert.deepEqual(called.filter((m) => !answered.has(m)), [])
  // And nothing mutating is missing from the table it gates.
  assert.deepEqual([...MUTATING].filter((m) => !METHODS.includes(m)), [])
})

test('ping sends exactly the body PearTune hosts always sent: no extra fields', async (t) => {
  const { testnet, host } = await scaffold(t)
  const client = await connectAs(t, testnet, host)
  const pong = await client.ping()
  assert.deepEqual(Object.keys(pong), ['protocol', 'libraryId', 'caps'])
  assert.equal(pong.libraryId, host.libraryId)
})

test('media.stream errors keep PearTune\'s codes and messages', async (t) => {
  const { testnet, host } = await scaffold(t)
  const client = await connectAs(t, testnet, host)
  assert.deepEqual(await errOf(client._request('media.stream', {}, { stream: true })), { code: 'EBADPARAMS', message: 'trackId required' })
  assert.deepEqual(await errOf(client._request('media.stream', { trackId: 'nope' }, { stream: true })), { code: 'ENOTFOUND', message: 'no such track' })
})

test('A NARROWED DEVICE GETS NO BYTES OF A HIDDEN TRACK, and the error says no such track', async (t) => {
  const { testnet, host } = await scaffold(t)
  const client = await connectAs(t, testnet, host, { paths: [{ root: host.adapter.roots[0], rel: 'Kids' }] })
  const all = await host.adapter.list({ type: 'tracks' })
  const rock = all.items.find((x) => x.path === 'rock.mp3')
  assert.ok(rock)
  assert.deepEqual(await errOf(client._request('media.stream', { trackId: rock.id }, { stream: true })), { code: 'ENOTFOUND', message: 'no such track' })
  assert.deepEqual(await errOf(client._request('art.get', { id: rock.id }, { stream: true })), { code: 'ENOTFOUND', message: 'no artwork' })
})

test('A READONLY DEVICE IS REFUSED EVERY MUTATING METHOD over the wire, and nothing else', async (t) => {
  const { testnet, host } = await scaffold(t)
  const client = await connectAs(t, testnet, host, { scope: 'readonly' })
  for (const method of MUTATING) {
    assert.deepEqual(await errOf(client._request(method, {})), { code: 'EFORBIDDEN', message: 'read-only grant' }, method)
  }
  assert.ok((await client._request('library.stats', {})).tracks >= 0, 'a read still works')
})

test('owner.claim takes effect on the same connection, no reconnect', async (t) => {
  const { testnet, host } = await scaffold(t)
  const client = await connectAs(t, testnet, host)
  assert.equal((await errOf(client._request('owner.devices', {}))).code, 'EFORBIDDEN')
  host.startPairing({ owner: true })
  const code = z32.encode(host.pairSession.rv)
  assert.deepEqual(await client._request('owner.claim', { code }), { ok: true })
  const { devices } = await client._request('owner.devices', {})
  assert.ok(devices.length >= 1)
})
