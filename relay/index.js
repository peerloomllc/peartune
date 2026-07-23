// Entry point for the blind relay daemon (proposal 2026-07-23-blind-relay, phase 1).
//
//   node relay/index.js            # run the relay, print its public key, then serve
//   RELAY_DATA_DIR=/var/lib/... node relay/index.js
//
// Prints the relay's PUBLIC KEY on startup. That z-base32 string is the constant
// you bake into the app + host in phase 2. It is stable across restarts (derived
// from relay.seed in the data dir), so bake it once.

const path = require('path')
const { createIdentity } = require('./identity')
const { RelayNode } = require('./relay')

const DATA_DIR = process.env.RELAY_DATA_DIR || path.join(__dirname, 'data')
const STATUS_MS = Number(process.env.RELAY_STATUS_MS || 60_000)

// A timestamped line so journald/docker logs are greppable. Structured fields as JSON.
function log (event, fields) {
  const ts = new Date().toISOString()
  const rest = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : ''
  console.log(`${ts} ${event}${rest}`)
}

async function main () {
  const identity = createIdentity(DATA_DIR)
  const node = new RelayNode({ keyPair: identity.keyPair, log })
  await node.ready()

  // The line an operator copies to bake the constant.
  log('relay:public-key', { key: node.publicKeyZ })
  console.log('\n  PeerLoom relay public key (bake this into the app + host):\n')
  console.log('    ' + node.publicKeyZ + '\n')

  const status = setInterval(() => log('relay:stats', node.stats), STATUS_MS)
  if (status.unref) status.unref()

  let closing = false
  const shutdown = async (sig) => {
    if (closing) return
    closing = true
    log('relay:shutdown', { signal: sig })
    clearInterval(status)
    await node.close()
    process.exit(0)
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  log('relay:fatal', { err: err.message })
  process.exit(1)
})
