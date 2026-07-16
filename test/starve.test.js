// The starvation decision.
//
// Every branch of decideStarve() gets a test, because this is what makes a revoke
// HONEST on the phone: a device whose buffer runs dry must stop cleanly, not sit on
// a frozen paused player forever. The bug this pins: the half-buffered revoke, where
// ExoPlayer errors out to `idle` (expo-audio ships no error event, so that state is
// the only signal) and the old buffering-only watchdog never fired because the
// periodic status poll goes silent the moment the player stops playing.
//
// Pure function, no device: the caller owns the clock and the watchdog ref, so the
// whole thing is deterministic. See app/starve.js and DECISIONS 2026-07-14.

const test = require('node:test')
const assert = require('node:assert/strict')

const { decideStarve, DEFAULT_GRACE_MS } = require('../app/starve')

const NOW = 1_000_000
const fresh = { pos: -1, at: NOW }

// A status update, with sane defaults for a healthy playing track.
const status = (over = {}) => ({
  dropped: false,
  playbackState: 'ready',
  isBuffering: false,
  positionMs: 5000,
  now: NOW,
  starve: fresh,
  graceMs: DEFAULT_GRACE_MS,
  ...over
})

test('on the wire, playing: never starved, window reset', () => {
  const d = decideStarve(status({ dropped: false, playbackState: 'ready' }))
  assert.equal(d.starved, false)
  assert.deepEqual(d.starve, { pos: -1, at: NOW })
})

test('on the wire, an idle player is NOT starved (startup / post-stop idle)', () => {
  // idle only means "errored out" once we are off the wire; on the wire it is the
  // benign pre-prepare / post-stop state and must not tear a fresh player down.
  const d = decideStarve(status({ dropped: false, playbackState: 'idle' }))
  assert.equal(d.starved, false)
})

test('THE FIX: dropped + idle = starved (the half-buffered revoke)', () => {
  const d = decideStarve(status({ dropped: true, playbackState: 'idle', isBuffering: false }))
  assert.equal(d.starved, true)
  assert.equal(d.reason, 'idle')
})

test('dropped + idle is starved even with a stale buffering window armed', () => {
  // The player passed through BUFFERING and then errored to idle inside the grace
  // window: isBuffering is now false, so the stall branch cannot catch it - the idle
  // branch must.
  const armed = { pos: 5000, at: NOW - 1000 }
  const d = decideStarve(status({ dropped: true, playbackState: 'idle', isBuffering: false, starve: armed, now: NOW }))
  assert.equal(d.starved, true)
})

test('dropped + playing from buffer: not starved (a buffered track rides out the drop)', () => {
  const d = decideStarve(status({ dropped: true, playbackState: 'ready', isBuffering: false }))
  assert.equal(d.starved, false)
  assert.deepEqual(d.starve, { pos: -1, at: NOW })
})

test('dropped + buffering, first frozen sample: arms the window, not yet starved', () => {
  const d = decideStarve(status({ dropped: true, isBuffering: true, playbackState: 'buffering', positionMs: 42000, now: NOW }))
  assert.equal(d.starved, false)
  assert.deepEqual(d.starve, { pos: 42000, at: NOW })
})

test('dropped + buffering, frozen within grace: still waiting', () => {
  const armed = { pos: 42000, at: NOW }
  const d = decideStarve(status({
    dropped: true, isBuffering: true, playbackState: 'buffering',
    positionMs: 42000, starve: armed, now: NOW + DEFAULT_GRACE_MS - 1
  }))
  assert.equal(d.starved, false)
  assert.deepEqual(d.starve, armed, 'window is preserved, not reset, so the grace accumulates')
})

test('dropped + buffering, frozen past grace: STARVED (the stall backstop)', () => {
  const armed = { pos: 42000, at: NOW }
  const d = decideStarve(status({
    dropped: true, isBuffering: true, playbackState: 'buffering',
    positionMs: 42000, starve: armed, now: NOW + DEFAULT_GRACE_MS + 1
  }))
  assert.equal(d.starved, true)
  assert.equal(d.reason, 'stall')
})

test('dropped + buffering but position ADVANCED: re-arms, not starved', () => {
  // Progress means the reconnect landed and bytes are flowing again - a switch, not a
  // revoke. Resetting the window is what lets a slow switch recover.
  const armed = { pos: 42000, at: NOW }
  const d = decideStarve(status({
    dropped: true, isBuffering: true, playbackState: 'buffering',
    positionMs: 43000, starve: armed, now: NOW + DEFAULT_GRACE_MS + 1
  }))
  assert.equal(d.starved, false)
  assert.deepEqual(d.starve, { pos: 43000, at: NOW + DEFAULT_GRACE_MS + 1 })
})

test('a user PAUSE while dropped is not a starve (pause is not buffering)', () => {
  // Frozen position, but not buffering -> a deliberate pause, not a starved buffer.
  const d = decideStarve(status({ dropped: true, isBuffering: false, playbackState: 'ready', positionMs: 5000 }))
  assert.equal(d.starved, false)
})
