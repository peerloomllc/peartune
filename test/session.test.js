// The play-session verdict: what a PLAYING device does about a session row it does not hold.
// Proposal 2026-07-30-one-device-plays. See worklet/session.js for the reasoning.

const test = require('node:test')
const assert = require('node:assert/strict')

const { sessionVerdict, ADOPT, STOP, CLAIM, LIVE_MS } = require('../worklet/session')

const NOW = 1_800_000_000_000 // a fixed clock, so the liveness window is exact
const live = (extra) => ({ isActiveHere: false, playing: true, updatedAt: NOW - 4_000, ...extra })

test('no session row at all: take it - we are the only device playing', () => {
  assert.equal(sessionVerdict(null), CLAIM)
  assert.equal(sessionVerdict(undefined), CLAIM)
})

test('the row already names us: adopt it, do not re-claim', () => {
  assert.equal(sessionVerdict({ isActiveHere: true, playing: true, updatedAt: NOW }, NOW), ADOPT)
  // Even if the row says "not playing" - the row is ours, we know what we are doing.
  assert.equal(sessionVerdict({ isActiveHere: true, playing: false, updatedAt: NOW }, NOW), ADOPT)
  // ...and a stale row of our own is still ours; the liveness window is about OTHER devices.
  assert.equal(sessionVerdict({ isActiveHere: true, playing: true, updatedAt: NOW - 864e5 }, NOW), ADOPT)
})

test('another device holds it AND is playing right now: stop - this is the two-at-once case', () => {
  assert.equal(sessionVerdict(live({ activeDeviceName: 'Pixel' }), NOW), STOP)
})

test('another device holds it but is NOT playing: claim, do not stop', () => {
  // THE GATE THAT MATTERS. The token persists as last-known after a device stops, so another
  // device can still offer "Play here". Without this branch a token left behind last week would
  // kill offline playback the moment this phone found wifi - worse than the bug being fixed.
  assert.equal(sessionVerdict(live({ playing: false, activeDeviceName: 'Pixel' }), NOW), CLAIM)
})

test('a STALE "playing" is a dead device, not a live one: claim, do not stop', () => {
  // A phone force-quit mid-song never writes playing:false, so its row insists forever. A live
  // holder heartbeats every ~4s, so anything older than the window is not actually playing.
  assert.equal(sessionVerdict(live({ updatedAt: NOW - LIVE_MS - 1 }), NOW), CLAIM)
  assert.equal(sessionVerdict(live({ updatedAt: NOW - LIVE_MS + 1 }), NOW), STOP, 'just inside the window still stops')
  // A row with no updatedAt at all reads as infinitely old - claim, never a mystery stop.
  assert.equal(sessionVerdict({ isActiveHere: false, playing: true }, NOW), CLAIM)
})

test('a row missing the playing flag entirely is not treated as playing', () => {
  // An older host, or a row written before `playing` rode the heartbeat. Silence is not a claim
  // that someone else is audibly playing, so we take the token rather than stopping ourselves.
  assert.equal(sessionVerdict({ isActiveHere: false, updatedAt: NOW }, NOW), CLAIM)
})
