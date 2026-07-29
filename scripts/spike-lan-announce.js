// SPIKE (2026-07-29): can a phone on the same WiFi reach a host whose announced LAN
// address is wrong, and does overriding that address rescue it?
//
// WHY THIS EXISTS. On StartOS the host runs in an LXC container holding only 10.0.3.x.
// hyperdht announces its LAN addresses from the SOCKET'S OWN interfaces
// (lib/server.js:214 -> lib/holepuncher.js:337), and the phone filters them with
// matchAddress (lib/holepuncher.js:356), which requires the FIRST OCTET to match. A
// 192.168.50.x phone therefore discards 10.0.3.x, loses the LAN path, and falls back to
// punching the router's external mapping - the hairpin most home routers refuse. That is
// the documented same-WiFi caveat, and both PeerLoom seeders ship "turn off WiFi to
// pair" because of it.
//
// The phone only ever sees what is ANNOUNCED, so the container is not needed to test
// this: lying about the announced address reproduces the phone's view exactly. That is
// what lets this run without root on a dev box.
//
//   ANNOUNCE=default   -> announce the real interfaces (baseline; LAN should work)
//   ANNOUNCE=10.99.0.5 -> announce a non-matching address (models the container)
//   ANNOUNCE=192.168.50.206:PORT -> the proposed fix: announce the BOX's LAN address
//
// Usage:
//   ANNOUNCE=10.99.0.5 DHT_PORT=49999 node scripts/spike-lan-announce.js <musicDir> <dataDir>
const path = require('path')
const Holepuncher = require('hyperdht/lib/holepuncher')
const { PearTuneHost } = require('../host/server.js')

const ANNOUNCE = process.env.ANNOUNCE || 'default'
const DHT_PORT = Number(process.env.DHT_PORT || 49999)
const HTTP_PORT = Number(process.env.HTTP_PORT || 18900)
const musicDir = process.argv[2] || path.join(__dirname, '..', 'test', 'fixtures', 'music')
const dataDir = process.argv[3] || '/tmp/spike-lan-data'

// THE PATCH UNDER TEST, in the smallest form that proves the point. The real fix would be
// an option on hyperdht rather than a monkey-patch, but the question here is only whether
// overriding the ANNOUNCED address changes what the phone does - not how to spell it.
//
// Patching the static is enough because lib/server.js and lib/connect.js both call it
// through the same module instance.
if (ANNOUNCE !== 'default') {
  const [host, portStr] = ANNOUNCE.split(':')
  const original = Holepuncher.localAddresses.bind(Holepuncher)
  Holepuncher.localAddresses = function (socket) {
    const real = original(socket)
    const port = portStr ? Number(portStr) : (real[0] ? real[0].port : DHT_PORT)
    const forged = [{ host, port }]
    console.log('[spike] announcing', JSON.stringify(forged), 'instead of', JSON.stringify(real))
    return forged
  }
}

async function main () {
  const HyperDHT = require('hyperdht')
  // Pin the DHT port. `new HyperDHT()` binds a RANDOM port per process - the
  // `opts.port || 49737` default at hyperdht/index.js:27 is only a preference and does
  // not survive - so a forwarded port needs this to be explicit.
  const dht = new HyperDHT({ port: DHT_PORT })
  await dht.ready()
  console.log('[spike] dht local socket =', dht.io.serverSocket.address().port, ' natPort =', dht.port)

  const host = new PearTuneHost({
    dataDir,
    musicDir,
    libraryName: 'Spike Host',
    dht,
    log: (m, d) => {
      if (/pair|connect|gate|host:/.test(m)) console.log('[host]', m, d ? JSON.stringify(d) : '')
    }
  })
  await host.ready()

  // Inside a container the dashboard must bind 0.0.0.0 or a published port cannot reach
  // it - and requireSafeBind refuses a non-loopback bind without a password, correctly.
  const bind = process.env.HTTP_BIND || '127.0.0.1'
  const password = process.env.HTTP_PASSWORD || ''
  const { startDashboard } = require('../host/ui/server.js')
  await startDashboard({
    host, bind, port: HTTP_PORT, password,
    passwordSource: password ? 'explicit' : 'none'
  })
  console.log(`[spike] dashboard http://127.0.0.1:${HTTP_PORT}`)
  console.log(`[spike] ANNOUNCE=${ANNOUNCE} DHT_PORT=${DHT_PORT}`)
  console.log('[spike] ready')
}

main().catch(e => { console.error('[spike] FAILED', e); process.exit(1) })
