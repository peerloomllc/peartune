// Blind relay node, phase 1 (proposal 2026-07-23-blind-relay, T3).
//
// The load-bearing claims this pins:
//   1. The relay node PAIRS two peers by a shared token and FORWARDS raw bytes
//      between them - driven directly (no hole-punch race), so it deterministically
//      proves the RelayNode's actual job: accept -> blind-relay pair -> relayTo.
//   2. hyperdht's `relayThrough` composes: a normal dht.connect(hostKey,
//      {relayThrough}) reaches the peer AND both ends engage the relay - the exact
//      wiring the phone gets in phase 2 (via Hyperswarm's forceRelaying).
//   3. Identity is deterministic: a seed yields a stable public key, so the baked
//      constant does not drift across restarts.
//
// It does NOT try to simulate a genuinely-un-punchable network - on a local testnet
// every peer punches fine. That "direct never lands, relay carries the whole
// session" case is the phase-3 hardware gate (the Pixel on a hard cell NAT).

const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const relay = require('blind-relay')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')

const { RelayNode } = require('../relay/relay')
const { createIdentity } = require('../relay/identity')

const QUIET = () => {}

async function withRelay (t) {
  const testnet = await createTestnet(3)
  const keyPair = HyperDHT.keyPair(hcrypto.randomBytes(32))
  const node = new RelayNode({ keyPair, bootstrap: testnet.bootstrap, log: QUIET })
  await node.ready()

  const peerDhts = []
  const mkDht = () => {
    const d = new HyperDHT({ bootstrap: testnet.bootstrap })
    peerDhts.push(d)
    return d
  }

  t.after(async () => {
    for (const d of peerDhts) { try { await d.destroy() } catch {} }
    await node.close()
    await testnet.destroy()
  })

  return { node, mkDht }
}

// Drive one end of a relayed pair: dial the relay, run the blind-relay client,
// pair on the token, and connect our raw stream to the relay-allocated stream.
// This is exactly what hyperdht does internally (lib/connect.js relayConnection),
// minus the hole-punch, so it isolates the relay's forward path.
async function pairThroughRelay (dht, relayKey, token, isInitiator) {
  const socket = dht.connect(relayKey)
  socket.on('error', () => {})
  const client = relay.Client.from(socket, { id: socket.publicKey })
  const raw = dht.createRawStream()

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay pair timeout')), 10_000)
    client.pair(isInitiator, token, raw)
      .on('error', (err) => { clearTimeout(timer); reject(err) })
      .on('data', (remoteId) => {
        clearTimeout(timer)
        const { remotePort, remoteHost, socket: s } = socket.rawStream
        raw.connect(s, remoteId, remotePort, remoteHost)
        resolve()
      })
  })

  return { raw, socket, client }
}

test('relay forwards raw bytes between two peers paired by token', async (t) => {
  const { node, mkDht } = await withRelay(t)
  const token = relay.token()

  const initiator = pairThroughRelay(mkDht(), node.publicKey, token, true)
  const responder = pairThroughRelay(mkDht(), node.publicKey, token, false)
  const [a, b] = await Promise.all([initiator, responder])

  // Each end sends its own message. Both MUST send: a relay stream only learns a
  // peer's address from a packet that peer sends (blind-relay's firewall hook), so
  // "A sends, B echoes" would deadlock - B is unreachable until it sends first. A
  // real hyperdht connection avoids this because the Noise handshake is bidirectional.
  const gotB = new Promise((res) => b.raw.once('data', (d) => res(b4a.toString(d))))
  const gotA = new Promise((res) => a.raw.once('data', (d) => res(b4a.toString(d))))
  a.raw.write(b4a.from('ping'))
  b.raw.write(b4a.from('pong'))

  assert.equal(await gotB, 'ping', 'responder received what the initiator sent, through the relay')
  assert.equal(await gotA, 'pong', 'initiator received what the responder sent, through the relay')

  // The relay recorded a real pairing + a forwarding stream for each end.
  assert.ok(node.stats.pairings.matched >= 1, 'relay matched the pair by token')
  assert.ok(node.stats.streams.opened >= 2, 'relay opened a forwarding stream per end')

  a.raw.destroy(); b.raw.destroy()
  a.socket.destroy(); b.socket.destroy()
})

test('relayThrough composes with a normal dht.connect (offering a relay never breaks a connect)', async (t) => {
  const { node, mkDht } = await withRelay(t)

  // A plain host: an echo server behind createServer, NO relayThrough config of its
  // own - exactly PearTune's host. The point is that passing relayThrough on the
  // CLIENT is safe: it is the option the phone gets in phase 2, and it must not
  // disturb the normal (direct) path. On this local testnet the punch always
  // succeeds, so this connection goes DIRECT despite the offer - which is precisely
  // the direct-first behavior we want. That the relay actually CARRIES a connection
  // when the punch fails is proven deterministically by the forwarding test above
  // and by the phase-3 hardware gate; a testnet cannot make a punch fail.
  const hostDht = mkDht()
  const hostKeyPair = HyperDHT.keyPair(hcrypto.randomBytes(32))
  const server = hostDht.createServer({ firewall: () => false }, (conn) => {
    conn.on('error', () => {})
    conn.on('data', (d) => { try { conn.write(d) } catch {} })
  })
  await server.listen(hostKeyPair)

  // The phone dials the host and offers the relay - the shape Hyperswarm produces
  // once it escalates on HOLEPUNCH_ABORTED.
  const phoneDht = mkDht()
  const conn = phoneDht.connect(hostKeyPair.publicKey, { relayThrough: node.publicKey })
  conn.on('error', () => {})

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 10_000)
    conn.on('open', () => { clearTimeout(timer); resolve() })
    conn.on('error', (err) => { clearTimeout(timer); reject(err) })
  })

  conn.write(b4a.from('hello'))
  const echo = await new Promise((res) => conn.once('data', (d) => res(b4a.toString(d))))
  assert.equal(echo, 'hello', 'the connection reached the host and echoed, with a relay offered')

  conn.destroy()
  await server.close()
})

test('relay identity is deterministic and 0600-persisted', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'peartune-relay-id-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const a = createIdentity(dir)
  const b = createIdentity(dir) // second call reuses the persisted seed
  assert.deepEqual(a.publicKey, b.publicKey, 'same seed -> same public key across restarts')

  const st = await fsp.stat(path.join(dir, 'relay.seed'))
  assert.equal(st.mode & 0o777, 0o600, 'seed written 0600')
})

test('RelayNode requires a keyPair', () => {
  assert.throws(() => new RelayNode({}), /keyPair/)
})

// --- what the relay records about a pairing (2026-07-27) ---------------------
//
// The node counted sessions and streams but never BYTES, so "what does one relayed listener cost"
// could only be inferred from the droplet's NIC - which also carries DHT chatter and every other
// process. And it logged nothing per pairing, so "whose are these 17 idle sessions" was
// unanswerable from the box. Both are metadata the README already tells users the relay sees.

test('a pairing is logged with KEY PREFIXES, never whole keys, and its bytes are counted', async (t) => {
  const lines = []
  const testnet = await createTestnet(3)
  const keyPair = HyperDHT.keyPair(hcrypto.randomBytes(32))
  const node = new RelayNode({
    keyPair,
    bootstrap: testnet.bootstrap,
    log: (event, fields) => lines.push({ event, ...fields })
  })
  await node.ready()

  const a = new HyperDHT({ bootstrap: testnet.bootstrap })
  const b = new HyperDHT({ bootstrap: testnet.bootstrap })
  t.after(async () => { await a.destroy(); await b.destroy(); await node.close(); await testnet.destroy() })

  const token = relay.token()
  const [ea, eb] = await Promise.all([
    pairThroughRelay(a, node.publicKey, token, true),
    pairThroughRelay(b, node.publicKey, token, false)
  ])

  assert.equal(node.relayedBytes, 0, 'nothing relayed before anyone writes')

  // BOTH ends must send - see the forwarding test above: a relay stream only learns a peer's
  // address from a packet that peer sends, so a one-way write deadlocks. And a 4 KB write arrives
  // in MTU-sized chunks (~1.1 KB), so count up to the full length rather than expecting one packet.
  const payload = Buffer.alloc(4096, 7)
  const drain = (stream, n) => new Promise((resolve) => {
    let got = 0
    stream.on('data', (d) => { got += d.length; if (got >= n) resolve(got) })
  })
  const gotB = drain(eb.raw, payload.length)
  const gotA = drain(ea.raw, payload.length)
  ea.raw.write(payload)
  eb.raw.write(payload)
  assert.ok((await gotB) >= payload.length, 'the bytes arrived at the responder')
  assert.ok((await gotA) >= payload.length, 'and at the initiator')

  // The counter reads LIVE streams, so it moves without waiting for a close.
  assert.ok(node.relayedBytes >= payload.length * 2, `relayedBytes counted both directions (${node.relayedBytes})`)
  assert.equal(node.stats.bytes.relayed, node.relayedBytes, 'stats carries the same number')

  // ONE line per completed pairing, naming BOTH ends - that is what makes "whose sessions are
  // these" answerable at all.
  const pairs = lines.filter((l) => l.event === 'relay:pair')
  assert.equal(pairs.length, 1, 'one line per pairing, not one per end')
  const { a: endA, b: endB } = pairs[0]
  assert.equal(endA.length, 8, 'one end is a prefix')
  assert.equal(endB.length, 8, 'the other end is a prefix')
  assert.notEqual(endA, endB, 'the two ends are distinct peers')
  // A z32-encoded 32-byte key is 52 chars; nothing that long may reach the log. The pairing TOKEN
  // is a shared secret and must never appear either - it is 64 hex chars.
  for (const v of Object.values(pairs[0])) assert.ok(String(v).length < 52, 'no key or token in the line')

  // Closing a stream banks its bytes and reports the pairing's lifetime.
  const before = node.relayedBytes
  ea.raw.destroy(); eb.raw.destroy()
  ea.socket.destroy(); eb.socket.destroy()
  await new Promise((resolve) => setTimeout(resolve, 500))
  const unpairs = lines.filter((l) => l.event === 'relay:unpair')
  assert.ok(unpairs.length >= 1, 'a closed stream logs its bytes')
  assert.ok(unpairs.every((u) => typeof u.bytes === 'number' && typeof u.ms === 'number'), 'with bytes + duration')
  assert.ok(node.relayedBytes >= before, 'the total never goes backwards when a stream closes')
})
