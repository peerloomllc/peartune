// The client-side relay policy (proposal 2026-07-23, phase 2). Pins the direct-first
// escalation + the privacy toggle + the "no key baked = inert" behavior, so the one
// line the phone adds to Hyperswarm (src/bare.js ensureSwarm) does exactly this.

const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')

const { relayThroughFor, RELAY_PUBLIC_KEY, RELAY_PUBLIC_KEY_Z } = require('../protocol/relay')

const KEY = b4a.alloc(32, 7) // a stand-in relay key

test('direct-first: no relay on the first attempt (not forced, not randomized)', () => {
  assert.equal(relayThroughFor({ force: false, randomized: false, useRelay: true, relayKey: KEY }), null)
})

test('escalates to the relay once forced (a HOLEPUNCH_ABORTED set force=true)', () => {
  assert.equal(relayThroughFor({ force: true, randomized: false, useRelay: true, relayKey: KEY }), KEY)
})

test('a double-randomized NAT relays from the first attempt (direct can never work)', () => {
  assert.equal(relayThroughFor({ force: false, randomized: true, useRelay: true, relayKey: KEY }), KEY)
})

test('the privacy toggle wins: useRelay=false never relays, even when forced', () => {
  assert.equal(relayThroughFor({ force: true, randomized: true, useRelay: false, relayKey: KEY }), null)
})

test('no key baked = inert: never relays regardless of force/NAT/toggle', () => {
  assert.equal(relayThroughFor({ force: true, randomized: true, useRelay: true, relayKey: null }), null)
})

test('the PeerLoom relay key is baked and decodes to a 32-byte key', () => {
  // Baked 2026-07-23 after the relay went live on a DigitalOcean droplet. With a key
  // present, relayThroughFor now returns it on the fail path (see the tests above).
  assert.equal(typeof RELAY_PUBLIC_KEY_Z, 'string')
  assert.ok(RELAY_PUBLIC_KEY_Z.length > 0, 'a z-base32 key string is set')
  assert.ok(b4a.isBuffer(RELAY_PUBLIC_KEY) || RELAY_PUBLIC_KEY instanceof Uint8Array)
  assert.equal(RELAY_PUBLIC_KEY.length, 32, 'decodes to a 32-byte public key')
})
