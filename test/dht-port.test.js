// PEARTUNE_DHT_PORT / `dhtPort`: pin the DHT's UDP socket.
//
// Why this is worth a test rather than a comment: the default LOOKS pinned and is not.
// hyperdht/index.js:27 reads `const port = opts.port || 49737`, so a casual read says every
// host binds 49737. It does not - dht-rpc treats it as a preference and the socket lands on a
// random port per process (36600 / 42742 / 59270 over three runs while scoping this). Anything
// forwarding to the host from outside - a router port-forward, or StartOS 0.4's bindPortRange -
// cannot forward a moving target, so the pin has to be real and has to stay real.
//
// See proposals/2026-07-29-start9-bindportrange.md.
const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const createTestnet = require('hyperdht/testnet')

const { PearTuneHost } = require('../host/server')

const QUIET = () => {}

async function scaffold (t, opts = {}) {
  const testnet = await createTestnet(3)
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'peartune-dhtport-'))
  const musicDir = path.join(dir, 'music')
  await fsp.mkdir(musicDir, { recursive: true })

  const host = new PearTuneHost({
    dataDir: path.join(dir, 'host-data'),
    musicDir,
    libraryName: 'Port Test',
    bootstrap: testnet.bootstrap,
    log: QUIET,
    ...opts
  })
  await host.ready()

  t.after(async () => {
    await host.close()
    await testnet.destroy()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  return host
}

// Pick a port unlikely to collide with anything on a dev box or in CI. If it IS taken the
// bind throws, which fails loudly rather than silently falling back - the behaviour we want.
const PINNED = 51737

test('dhtPort pins the DHT UDP socket to exactly that port', async (t) => {
  const host = await scaffold(t, { dhtPort: PINNED })
  assert.equal(host.dht.io.serverSocket.address().port, PINNED)
})

test('dhtPort accepts a string, as it arrives from the environment', async (t) => {
  // PEARTUNE_DHT_PORT comes through process.env, so it is always a string. Passing that
  // straight to hyperdht without Number() binds a random port instead of throwing, which
  // would look exactly like the feature working until someone checked the socket.
  const host = await scaffold(t, { dhtPort: String(PINNED + 1) })
  assert.equal(host.dht.io.serverSocket.address().port, PINNED + 1)
})

test('no dhtPort leaves the default behaviour untouched', async (t) => {
  const host = await scaffold(t)
  const port = host.dht.io.serverSocket.address().port
  assert.ok(port > 0, 'still binds a port')
  assert.notEqual(port, PINNED, 'not silently pinned to the test port')
})

test('an injected dht is never re-configured by dhtPort', async (t) => {
  // The `dht` option means "use this one" - tests and the probe harness share a testnet
  // node. dhtPort must not quietly apply to a socket it does not own.
  const testnet = await createTestnet(3)
  const HyperDHT = require('hyperdht')
  const shared = new HyperDHT({ bootstrap: testnet.bootstrap })
  await shared.ready()
  const before = shared.io.serverSocket.address().port

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'peartune-dhtport-inj-'))
  const musicDir = path.join(dir, 'music')
  await fsp.mkdir(musicDir, { recursive: true })
  const host = new PearTuneHost({
    dataDir: path.join(dir, 'host-data'),
    musicDir,
    libraryName: 'Injected',
    dht: shared,
    dhtPort: PINNED + 2,
    log: QUIET
  })
  await host.ready()

  t.after(async () => {
    await host.close()
    await shared.destroy()
    await testnet.destroy()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  assert.equal(host.dht, shared, 'uses the injected dht')
  assert.equal(shared.io.serverSocket.address().port, before, 'its port is unchanged')
})
