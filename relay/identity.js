// The relay's identity: a 32-byte seed, generated once on the VPS, stored 0600,
// never leaving the box. The seed derives the relay keypair whose PUBLIC key is
// the constant baked into the app and the host (phase 2). Keep the seed stable or
// the relay's public key changes and every client's baked constant goes stale.
//
// Unlike the host seed, this one is NOT library-sensitive: it authenticates a
// blind byte-forwarder, not a music library. Losing it just means minting a new
// relay key and re-baking the constant. Still 0600 - no reason to leak it.

const fs = require('fs')
const path = require('path')
const HyperDHT = require('hyperdht')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')

const SEED_FILE = 'relay.seed'

function loadOrCreateSeed (dataDir) {
  const file = path.join(dataDir, SEED_FILE)

  if (fs.existsSync(file)) {
    const hex = fs.readFileSync(file, 'utf8').trim()
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new Error(`corrupt relay seed at ${file}: expected 64 hex chars`)
    }
    return b4a.from(hex, 'hex')
  }

  fs.mkdirSync(dataDir, { recursive: true })
  const seed = hcrypto.randomBytes(32)
  fs.writeFileSync(file, b4a.toString(seed, 'hex'), { mode: 0o600, flag: 'wx' })
  return seed
}

function createIdentity (dataDir) {
  const seed = loadOrCreateSeed(dataDir)
  const keyPair = HyperDHT.keyPair(seed)
  return { seed, keyPair, publicKey: keyPair.publicKey }
}

module.exports = { createIdentity, loadOrCreateSeed, SEED_FILE }
