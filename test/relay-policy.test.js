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

test('ships with no relay key baked yet (phase 1 deploy is still pending)', () => {
  // These assertions are the reminder to bake the key after the VPS is up. Once the
  // relay is deployed and RELAY_PUBLIC_KEY_Z is set, update this test to assert the
  // decoded key is a 32-byte buffer instead.
  assert.equal(RELAY_PUBLIC_KEY_Z, null)
  assert.equal(RELAY_PUBLIC_KEY, null)
})
