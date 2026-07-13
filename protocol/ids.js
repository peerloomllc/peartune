// Deterministic id derivation. Every id here MUST be reproducible from stable
// inputs, because a host restart that changed `libraryId` would orphan the
// ledger, and a rescan that changed `trackId` would orphan every resume
// position, favorite and play count.
//
// Domain separation is not decoration: these ids are all derived from 32 bytes
// of overlapping material, and an unnamespaced collision between two of them
// would leak one context into another. Every hash below is namespaced.

const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const z32 = require('z32')

const NS_LIBRARY = hcrypto.hash(b4a.from('peartune/library/1'))
const NS_TRACK = hcrypto.hash(b4a.from('peartune/track/1'))
const NS_LEDGER_TOPIC = hcrypto.hash(b4a.from('peartune/ledger-topic/1'))

function toBuf (x) {
  if (b4a.isBuffer(x)) return x
  if (typeof x === 'string') return b4a.from(x)
  throw new Error('expected buffer or string')
}

// The library's stable identity, derived from the host's public key. Survives a
// host restart (same seed -> same keypair -> same libraryId); a NEW host
// identity is deliberately a clean new library rather than a corrupted old one.
function libraryId (hostKey) {
  return z32.encode(hcrypto.hash(b4a.concat([NS_LIBRARY, toBuf(hostKey)])))
}

// Source-scoped by design: the same file reached via Navidrome and via a raw
// folder hashes differently, so switching sources orphans listening state. That
// is an accepted, warned-about v1 tradeoff - see DECISIONS 2026-07-13. Do not
// "fix" this by dropping libraryId or sourceKind from the input without reading
// that entry first.
//
// sourceKind: 'navidrome' | 'folder'
// sourceKey:  the Navidrome track id, or the library-relative file path.
function trackId (libId, sourceKind, sourceKey) {
  if (!libId || !sourceKind || !sourceKey) throw new Error('trackId needs libraryId, sourceKind, sourceKey')
  return z32.encode(hcrypto.hash(b4a.concat([
    NS_TRACK,
    z32.decode(libId),
    toBuf(sourceKind),
    toBuf(sourceKey)
  ])))
}

// Steady-state swarm topic for the shared ledger (resume / favorites / counts),
// used from milestone 3. Namespaced so it can never collide with any other topic
// the suite derives.
function ledgerTopic (libId) {
  return hcrypto.hash(b4a.concat([NS_LEDGER_TOPIC, z32.decode(libId)]))
}

// One-time pairing token, presented by the phone to prove it saw the QR. Not a
// topic: pairing dials the host by key. See host/pair.js.
function randomRv () {
  return hcrypto.randomBytes(32)
}

module.exports = { libraryId, trackId, ledgerTopic, randomRv }
