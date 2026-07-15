// Id derivation.
//
// These ids are load-bearing in a way that is easy to underrate: `libraryId`
// must survive a host restart or the ledger is orphaned, and `trackId` must
// survive a rescan or every resume position, favorite and play count is
// orphaned. A careless refactor of ids.js is a data-loss bug, so it gets pinned.

const test = require('node:test')
const assert = require('node:assert/strict')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')

const { libraryId, trackId, ledgerTopic, randomRv } = require('../protocol/ids')

const hostKey = hcrypto.keyPair().publicKey
const lib = libraryId(hostKey)

test('libraryId is deterministic from the host key (survives a restart)', () => {
  assert.equal(libraryId(hostKey), lib)
  assert.equal(libraryId(hostKey), libraryId(hostKey))
})

test('a different host is a different library', () => {
  const other = libraryId(hcrypto.keyPair().publicKey)
  assert.notEqual(other, lib)
})

test('trackId is deterministic and stable across rescans', () => {
  const a = trackId(lib, 'folder', 'Pink Floyd/Meddle/01 One of These Days.flac')
  const b = trackId(lib, 'folder', 'Pink Floyd/Meddle/01 One of These Days.flac')
  assert.equal(a, b)
})

test('trackId is SOURCE-SCOPED: the same file via folder vs subsonic differs', () => {
  // This is deliberate and it is why switching sources orphans listening state.
  // See DECISIONS 2026-07-13. If this test ever "fails" because someone made ids
  // source-agnostic, that is a protocol change, not a bug fix - read the entry.
  const viaFolder = trackId(lib, 'folder', 'abc.flac')
  const viaSubsonic = trackId(lib, 'subsonic', 'abc.flac')
  assert.notEqual(viaFolder, viaSubsonic)
})

test('trackId is scoped to the library: the same path on two hosts differs', () => {
  const otherLib = libraryId(hcrypto.keyPair().publicKey)
  assert.notEqual(trackId(lib, 'folder', 'abc.flac'), trackId(otherLib, 'folder', 'abc.flac'))
})

test('trackId rejects missing inputs rather than hashing undefined', () => {
  assert.throws(() => trackId(lib, 'folder', ''), /needs libraryId/)
  assert.throws(() => trackId(lib, '', 'a.flac'), /needs libraryId/)
  assert.throws(() => trackId('', 'folder', 'a.flac'), /needs libraryId/)
})

test('ledgerTopic is deterministic per library and namespaced', () => {
  const lt = ledgerTopic(lib)
  assert.equal(lt.byteLength, 32)
  assert.ok(b4a.equals(ledgerTopic(lib), lt))
  // A different library is a different topic.
  assert.ok(!b4a.equals(ledgerTopic(libraryId(hcrypto.keyPair().publicKey)), lt))
})

test('randomRv yields 32 unguessable bytes', () => {
  const a = randomRv()
  assert.equal(a.byteLength, 32)
  assert.ok(!b4a.equals(a, randomRv()))
})
