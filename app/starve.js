'use strict'

// STARVATION DECISION - extracted from the shell's playback-status listener so it
// can be unit-tested away from React Native. This is a security-adjacent path: a
// revoked device whose buffer runs dry must STOP CLEANLY, not freeze on a paused
// player forever. See DECISIONS 2026-07-14 (graceful-reconnect).
//
// Pure and deterministic: given ONE playback-status update plus the running
// watchdog state, return whether to end playback and the next watchdog state. The
// caller owns the mutable ref and the clock (`now`), so every branch is testable
// without a device - the same reason host/gate.js's decide() is a pure function.
//
// A DROP is not a stop (a wifi<->cellular switch and a revoke look identical at the
// instant of disconnect). We keep the buffer playing and let the player's own fate
// decide. Two ways a DROPPED player ends:
//
//  - IDLE: ExoPlayer exhausted its bounded retries on the broken source and errored
//    out. expo-audio ships NO error listener, so `playbackState: 'idle'` is the only
//    signal we get, and an idle player never recovers on its own. This is the
//    half-buffered revoke: the in-flight load broke, every retry was denied (the shim
//    res.destroy()s each one), and the player gave up. A FULLY buffered track never
//    reaches here - its load already completed, so it has all its bytes and plays to
//    the end, which is the deliberate "the current track may finish" of the decision.
//
//  - STALL: it sits in BUFFERING with the position frozen past the grace window. A
//    backstop for a source that HANGS instead of erroring to idle; `isBuffering` is
//    what tells a starve apart from a user PAUSE (a pause is not buffering).
//
// A player that is not dropped, or is playing normally / paused by the user, is
// never starved.

const DEFAULT_GRACE_MS = 15000

// starve: { pos, at } - the last position we saw frozen while buffering, and when.
// Returns { starved, reason, starve } - starved=true means tear the player down;
// reason names which branch fired ('idle' | 'stall' | null) for diagnostics; starve
// is the watchdog state to carry into the next call.
function decideStarve ({
  dropped,
  playbackState,
  isBuffering,
  positionMs,
  now,
  starve,
  graceMs = DEFAULT_GRACE_MS
}) {
  // On the wire, or reconnected: nothing to watch, reset the window.
  if (!dropped) return { starved: false, reason: null, starve: { pos: -1, at: now } }

  // Terminal: the player errored out and will not come back.
  if (playbackState === 'idle') return { starved: true, reason: 'idle', starve }

  // Stalled: buffering with no forward progress. Arm the window on the first frozen
  // sample; fire once it has been frozen longer than the grace period.
  if (isBuffering) {
    if (positionMs !== starve.pos) return { starved: false, reason: null, starve: { pos: positionMs, at: now } }
    if (now - starve.at > graceMs) return { starved: true, reason: 'stall', starve }
    return { starved: false, reason: null, starve }
  }

  // Dropped but still playing from buffer (a buffered track riding out the drop), or
  // paused by the user: keep the queue, reset the window.
  return { starved: false, reason: null, starve: { pos: -1, at: now } }
}

// RECOVERY decision for a dead player (proposal 2026-08-16-seekable-transcodes,
// slice 3). A TRANSCODED source that breaks cannot be resumed by ExoPlayer - no byte
// ranges - so the player errors out to idle and, before this existed, playback simply
// ended ("stops a few seconds into the next song", Tim, off LAN). The shell now asks:
// should we try re-entering the stream at the last known position?
//
// Deliberately dumb and bounded: ONE retry per death, reset only by real forward
// progress or a track change. The retry itself is an ordinary stream request, so a
// REVOKED device's retry is denied at the host's gate and the second death lands here
// with tries spent - playback ends, exactly as the revoke acceptance test demands,
// one denied request later.
//
// `cause` names how the player died: 'idle' | 'error' straight from playbackState
// (a source that broke outright), or 'starve' when decideStarve just fired (a stalled
// buffer past its grace). Anything else - a player that is merely buffering, paused
// or playing - is not dead and must not be "recovered".
//
// Pure for the same reason decideStarve is: every branch testable without a device.
function decideRecover ({ cause, tries, maxTries = 1, hasQueue, casting = false }) {
  if (casting || !hasQueue) return false // cast mode plays silence slots; nothing to save
  if (cause !== 'idle' && cause !== 'error' && cause !== 'starve') return false
  return tries < maxTries
}

module.exports = { decideStarve, decideRecover, DEFAULT_GRACE_MS }
