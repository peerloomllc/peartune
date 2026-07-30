// Per-library relay-audio consent (proposal 2026-07-29-relay-audio-consent).
//
// Three things are pinned here, and each one is a silent failure if it regresses:
//
//   1. the policy itself - what plays, what asks, what is refused
//   2. that AUDIO ONLY is gated. Decision 1 (Tim, 2026-07-29) allows browse, search and
//      artwork over the relay without a prompt, DISCLOSED on the privacy page. A later
//      "let's tighten this up" that routes art or metadata through the gate would make
//      that page inaccurate, which is worse than the looser behavior.
//   3. that patches/hyperswarm+*.patch is applied. Without it Hyperswarm never hands our
//      relayThrough callback a peerInfo, so nothing is ever recorded as relayed, so
//      NOTHING IS EVER GATED - and every test above still passes. That is the whole
//      reason this third block exists: the gate fails OPEN, quietly, on a dependency bump.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { relayAudioDecision } = require('../protocol/relay')
const hostList = require('../worklet/hosts')

const ROOT = path.join(__dirname, '..')

// --- 1. the policy -----------------------------------------------------------

test('a DIRECT library always plays, whatever the consent says', () => {
  // Nothing of PeerLoom's is in the path, so there is nothing to consent to. This is the
  // overwhelmingly common case: on cellular both hosts punched directly (DECISIONS
  // 2026-07-23 phase 3) and the relay stayed out entirely.
  for (const consent of ['ask', 'allow', 'deny', undefined]) {
    assert.equal(relayAudioDecision({ relayed: false, consent }), 'play', `consent=${consent}`)
  }
})

test('a relayed library asks the first time', () => {
  assert.equal(relayAudioDecision({ relayed: true, consent: 'ask' }), 'ask')
})

test('a library never asked before (no stored field) asks', () => {
  // worklet/hosts.js stores the field only when it is allow/deny, so "never asked" is an
  // ABSENT field, not the string 'ask'. Both must read the same way.
  assert.equal(relayAudioDecision({ relayed: true, consent: undefined }), 'ask')
  assert.equal(relayAudioDecision({ relayed: true, consent: '' }), 'ask')
})

test('allow plays without asking again', () => {
  assert.equal(relayAudioDecision({ relayed: true, consent: 'allow' }), 'play')
})

test('deny is REFUSE, not ask - a standing no does not nag (decision 3)', () => {
  assert.equal(relayAudioDecision({ relayed: true, consent: 'deny' }), 'refuse')
})

// --- 2. audio only -----------------------------------------------------------

test('the shim gates the TRACK path and NOT the art path (decision 1)', () => {
  const shim = fs.readFileSync(path.join(ROOT, 'worklet/shim.js'), 'utf8')

  const gateAt = shim.indexOf('audioGate({')
  assert.ok(gateAt > 0, 'the shim calls audioGate somewhere')

  // The art handler starts at the artStore/localOnly branch. The single audioGate call
  // must sit BEFORE it, in the track handler.
  const artAt = shim.indexOf('if (artStore && (localOnly')
  assert.ok(artAt > 0, 'found the art branch')
  assert.ok(gateAt < artAt,
    'audioGate is called at or after the art branch - artwork must NOT be gated (decision 1). ' +
    'If art is now meant to require consent, website/peartune/privacy.html has to change first.')

  assert.equal(shim.split('audioGate(').length - 1, 1,
    'audioGate is called more than once. Only the audio path may be gated; adding a second ' +
    'call site means metadata or art is now gated too, which contradicts the privacy page.')
})

test('a cache hit is served BEFORE the gate, so a pinned album still plays when refused', () => {
  const shim = fs.readFileSync(path.join(ROOT, 'worklet/shim.js'), 'utf8')
  const cacheAt = shim.indexOf('return serveFromCache(trackId, req, res)')
  const gateAt = shim.indexOf('audioGate({')
  assert.ok(cacheAt > 0 && gateAt > 0)
  assert.ok(cacheAt < gateAt,
    'the gate now runs before the cache hit, so declining the relay would also black out ' +
    'downloaded albums. They need no connection at all - keep the cache path first.')
})

// --- 3. the store -----------------------------------------------------------

test('consent round-trips per library and is ABSENT until set (no migration)', () => {
  const base = {
    version: 2,
    activeHostKey: 'k1',
    hosts: [
      { hostKey: 'k1', libraryId: 'lib1', libraryName: 'Mine', addedAt: 1 },
      { hostKey: 'k2', libraryId: 'lib2', libraryName: 'A friend', addedAt: 2 }
    ]
  }

  // Untouched: no field at all, so an older build reads the file exactly as it did before
  // this change existed.
  assert.equal('relayAudio' in hostList.normalize(base).hosts[0], false)
  assert.equal(hostList.relayAudioFor(base, 'lib1'), 'ask')

  const denied = hostList.setRelayAudio(base, 'k1', 'deny')
  assert.equal(hostList.relayAudioFor(denied, 'lib1'), 'deny')
  // PER LIBRARY: the other one is untouched. This is the point of the whole change - the
  // old global useRelay switch could not express "yes to my Umbrel, no to my friend's".
  assert.equal(hostList.relayAudioFor(denied, 'lib2'), 'ask')

  const allowed = hostList.setRelayAudio(denied, 'k1', 'allow')
  assert.equal(hostList.relayAudioFor(allowed, 'lib1'), 'allow')

  // Anything else clears it back to "ask me again".
  assert.equal(hostList.relayAudioFor(hostList.setRelayAudio(allowed, 'k1', 'ask'), 'lib1'), 'ask')
  assert.equal('relayAudio' in hostList.setRelayAudio(allowed, 'k1', 'ask').hosts[0], false)
})

test('a garbage stored value reads as ask, never as allow', () => {
  // Fail SAFE: a hand-edited or corrupted file must not silently grant the relay.
  for (const bad of ['ALLOW', 'yes', 'true', 1, {}, null]) {
    const f = { version: 2, activeHostKey: 'k1', hosts: [{ hostKey: 'k1', libraryId: 'lib1', libraryName: 'x', addedAt: 1, relayAudio: bad }] }
    assert.equal(hostList.relayAudioFor(f, 'lib1'), 'ask', `stored ${JSON.stringify(bad)}`)
  }
})

// --- 4. the patch that makes any of this work --------------------------------

test('the hyperswarm patch is present and forwards peerInfo', () => {
  const dir = path.join(ROOT, 'patches')
  const patch = fs.readdirSync(dir).find((f) => /^hyperswarm\+.*\.patch$/.test(f))
  assert.ok(patch,
    'patches/hyperswarm+<version>.patch is GONE. Hyperswarm calls relayThrough(force, swarm) ' +
    'without it, so src/bare.js records nothing as relayed and the consent gate silently ' +
    'never fires. Regenerate it: edit node_modules/hyperswarm/index.js to pass peerInfo ' +
    'through _maybeRelayConnection, then `npx patch-package hyperswarm`.')

  const body = fs.readFileSync(path.join(dir, patch), 'utf8')
  assert.match(body, /_maybeRelayConnection\(force, peerInfo\)/, 'the patch still widens the signature')
  assert.match(body, /this\.relayThrough\(force, this, peerInfo\)/, 'the patch still forwards peerInfo to our callback')
  assert.match(body, /_maybeRelayConnection\(peerInfo\.forceRelaying, peerInfo\)/, 'the patch still passes peerInfo at the connect site')
})

test('the installed hyperswarm actually has the patch applied', () => {
  // The patch FILE existing is not the same as it having been applied - a fresh clone that
  // skipped postinstall, or a bumped hyperswarm the patch no longer applies to, both leave
  // the file in place and the gate dead. Check the installed code.
  const installed = path.join(ROOT, 'node_modules/hyperswarm/index.js')
  if (!fs.existsSync(installed)) return // no install here; the patch-file test above still ran
  const src = fs.readFileSync(installed, 'utf8')
  assert.match(src, /this\.relayThrough\(force, this, peerInfo\)/,
    'node_modules/hyperswarm is NOT patched, so relayThrough never receives peerInfo and the ' +
    'relay-consent gate is inert. Run `npx patch-package` (npm postinstall does this).')
})

// --- 5. the pairing-path regression ------------------------------------------

test('relayed-ness is derived per request, NOT cached by onSwarmConnection', () => {
  // WHAT THIS PINS, and what it does not claim.
  //
  // The first implementation cached relayed-ness per library in onSwarmConnection. That
  // handler EARLY-RETURNS on the pairing path - the host is not in hosts.json yet, so its
  // connection is handed to the in-flight pair handshake - and the app then keeps using
  // that very connection. So a library's first session after pairing would record nothing,
  // the gate would read "not relayed", and audio would stream over the relay unasked.
  // That is the UNSAFE direction, and pairing is precisely when a user is most likely to
  // be on the network that needs the relay.
  //
  // This is a code-path argument, NOT a reproduced failure: the 2026-07-29 TCL run could
  // not distinguish it, because that Mac mini connection was genuinely direct (a LAN
  // punch, logged relayed:false), so playing without a prompt was correct there. Deriving
  // from the recorded per-HOST decision makes the gate independent of which path the
  // connection took, so the case cannot arise either way.
  const src = fs.readFileSync(path.join(ROOT, 'src/bare.js'), 'utf8')

  assert.match(src, /function libraryRelayed \(libraryId\)/,
    'libraryRelayed() is gone - the gate must derive relayed-ness, not read a cache')
  assert.doesNotMatch(src, /relayedLibs/,
    'a per-library relayed cache is back. onSwarmConnection cannot be the place that ' +
    'records it: it early-returns on the pairing path, so the first session after ' +
    'pairing would relay audio without asking.')

  // The gate must consult the derivation, not a map lookup.
  const gate = src.slice(src.indexOf('function relayAudioGate'), src.indexOf('function setRelayAudioConsent'))
  assert.match(gate, /libraryRelayed\(lib\)/, 'relayAudioGate no longer calls libraryRelayed')
})

test('src/bare.js records the decision from peerInfo, and tolerates it being absent', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/bare.js'), 'utf8')
  assert.match(src, /relayThrough: \(force, s, peerInfo\)/,
    'the relayThrough callback no longer takes peerInfo')
  assert.match(src, /if \(peerInfo && peerInfo\.publicKey\) relayOffered\.set/,
    'the peerInfo guard is gone. hyperdht calls the SERVER-side relayThrough with no ' +
    'arguments at all, so an unguarded read throws on every inbound connection.')
})
