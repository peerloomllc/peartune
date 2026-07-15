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
const NS_GROUP = hcrypto.hash(b4a.from('peartune/group/1'))
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

// Source-scoped by design: the same file reached via a Subsonic server and via a
// raw folder hashes differently, so switching sources orphans listening state. That
// is an accepted, warned-about v1 tradeoff - see DECISIONS 2026-07-13. Do not
// "fix" this by dropping libraryId or sourceKind from the input without reading
// that entry first.
//
// sourceKind: 'subsonic' | 'jellyfin' | 'folder'
// sourceKey:  the server's track id, or the library-relative file path.
function trackId (libId, sourceKind, sourceKey) {
  if (!libId || !sourceKind || !sourceKey) throw new Error('trackId needs libraryId, sourceKind, sourceKey')
  return z32.encode(hcrypto.hash(b4a.concat([
    NS_TRACK,
    z32.decode(libId),
    toBuf(sourceKind),
    toBuf(sourceKey)
  ])))
}

// An album or an artist id, for a source that has none of its own.
//
// Navidrome and Jellyfin hand us their own album and artist ids and we pass them
// through untouched. A FOLDER has no such thing: an album is a fact we infer from
// tags, so we have to mint the id ourselves - and it has to be stable, or every
// rescan would hand the phone a fresh set of album ids and invalidate its art
// cache for a library that did not change.
//
// Separate namespace from NS_TRACK on purpose. These ids travel the same wire and
// end up in the same `id` fields; an album id that could collide with a track id
// would be a lookup that silently answers the wrong object.
//
// UNLIKE trackId, these are NOT ledger keys - nothing durable is filed under an
// album id - so their derivation may be changed without orphaning anyone's resume
// positions. Changing trackId may not. Keep it that way.
//
// type: 'album' | 'artist'
// key:  a normalized grouping key (see host/adapters/folder.js)
function groupId (libId, sourceKind, type, key) {
  if (!libId || !sourceKind || !type || !key) throw new Error('groupId needs libraryId, sourceKind, type, key')
  return z32.encode(hcrypto.hash(b4a.concat([
    NS_GROUP,
    z32.decode(libId),
    toBuf(sourceKind),
    toBuf(type),
    toBuf(key)
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

module.exports = { libraryId, trackId, groupId, ledgerTopic, randomRv }
