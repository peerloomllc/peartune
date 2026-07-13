// Host identity: a 32-byte seed, generated once, stored 0600, never leaving the
// machine.
//
// This seed IS the library's address. Anyone holding it can impersonate the
// host and harvest devices that try to pair. It is why `host-data/` and `*.seed`
// are in .gitignore, and why the file is written with an explicit mode rather
// than whatever the umask happens to be.

const fs = require('fs')
const path = require('path')
const HyperDHT = require('hyperdht')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const { libraryId } = require('../protocol/ids')

const SEED_FILE = 'host.seed'

function loadOrCreateSeed (dataDir) {
  const file = path.join(dataDir, SEED_FILE)

  if (fs.existsSync(file)) {
    const hex = fs.readFileSync(file, 'utf8').trim()
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new Error(`corrupt seed at ${file}: expected 64 hex chars`)
    }
    return b4a.from(hex, 'hex')
  }

  fs.mkdirSync(dataDir, { recursive: true })
  const seed = hcrypto.randomBytes(32)
  // 0600 explicitly, and via the open mode rather than a chmod afterwards, so
  // there is no window where the seed sits world-readable on disk.
  fs.writeFileSync(file, b4a.toString(seed, 'hex'), { mode: 0o600, flag: 'wx' })
  return seed
}

function createIdentity (dataDir) {
  const seed = loadOrCreateSeed(dataDir)
  const keyPair = HyperDHT.keyPair(seed)
  return {
    seed,
    keyPair,
    publicKey: keyPair.publicKey,
    libraryId: libraryId(keyPair.publicKey)
  }
}

module.exports = { createIdentity, loadOrCreateSeed, SEED_FILE }
