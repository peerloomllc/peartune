// Persistent-Hyperswarm transport, phase 1: the host announces a discovery topic
// so a phone can find it by LOOKUP (and keep retrying until a hole-punch lands)
// instead of only by a one-shot dht.connect. Proposal 2026-07-22.
//
// The load-bearing claims this pins:
//   1. A GRANTED device that joins the host topic via Hyperswarm gets a connection
//      to the host - discovery works, and the async firewall admits it.
//   2. A STRANGER that joins the same topic gets NOTHING - the firewall is still
//      the sole admission control; finding the host on the topic buys no access.
//   3. Backward compat: a raw dht.connect(hostKey) still reaches the host, so an
//      un-upgraded phone keeps working against an upgraded host.

const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const Hyperswarm = require('hyperswarm')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')

const { PearTuneHost } = require('../host/server')
const { PearTuneClient } = require('../client')
const { hostTopic } = require('../protocol/ids')

const QUIET = () => {}

async function scaffold (t) {
  const testnet = await createTestnet(3)
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'peartune-transport-'))
  const musicDir = path.join(dir, 'music')
  await fsp.mkdir(musicDir, { recursive: true })
  await fsp.writeFile(path.join(musicDir, 'a.flac'), b4a.alloc(1024))

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

  return { testnet, host, dir }
}

// Pair a keyPair with the host so it holds a real grant, using the ordinary
// dht.connect pairing path (unchanged by this proposal).
async function grantDevice (testnet, host, keyPair) {
  const client = new PearTuneClient({ keyPair, bootstrap: testnet.bootstrap, log: QUIET })
  const link = host.startPairing()
  await client.pair(link, { label: 'phone', platform: 'android' })
  await client.close()
}

// Join a topic as a pure Hyperswarm client and resolve to the first connection's
// remote public key (hex), or null if none arrives inside `ms`.
async function firstTopicConn (testnet, keyPair, topic, ms = 6000) {
  const swarm = new Hyperswarm({ keyPair, bootstrap: testnet.bootstrap })
  let remoteHex = null
  swarm.on('connection', (conn, info) => {
    conn.on('error', () => {})
    if (!remoteHex) remoteHex = b4a.toString(info.publicKey, 'hex')
  })
  swarm.join(topic, { server: false, client: true })
  await swarm.flush()
  const started = Date.now()
  while (!remoteHex && Date.now() - started < ms) {
    await new Promise((r) => setTimeout(r, 100))
  }
  await swarm.destroy()
  return remoteHex
}

test('a GRANTED device finds the host over the discovery topic', async (t) => {
  const { testnet, host } = await scaffold(t)

  const keyPair = hcrypto.keyPair()
  await grantDevice(testnet, host, keyPair)

  const topic = hostTopic(host.publicKey)
  const remote = await firstTopicConn(testnet, keyPair, topic)

  assert.equal(remote, b4a.toString(host.publicKey, 'hex'),
    'the topic connection is to the host, by its real key')
})

test('a STRANGER on the topic is refused - the firewall is still the only gate', async (t) => {
  const { testnet, host } = await scaffold(t)

  // Never paired -> no grant. Joining the topic must get it nowhere.
  const stranger = hcrypto.keyPair()
  const topic = hostTopic(host.publicKey)
  const remote = await firstTopicConn(testnet, stranger, topic, 4000)

  assert.equal(remote, null, 'an ungranted device gets no connection off the topic')
})

test('backward compat: a raw dht.connect(hostKey) still reaches the host', async (t) => {
  const { testnet, host } = await scaffold(t)

  const keyPair = hcrypto.keyPair()
  await grantDevice(testnet, host, keyPair)

  // The un-upgraded-phone path: dial the key directly, no topic involved.
  const client = new PearTuneClient({ keyPair, bootstrap: testnet.bootstrap, log: QUIET })
  t.after(() => client.close())
  await client.connect({ hostKey: host.publicKey, libraryId: host.libraryId })
  const pong = await client.ping()
  assert.equal(pong.libraryId, host.libraryId)
})
