// The play-session verdict: what a device that is PLAYING should do about a session row it does
// not hold. Pure, so the decision is testable without a host, a phone or a network - src/bare.js
// does the I/O around it (proposal 2026-07-30-one-device-plays).
//
// WHY THIS EXISTS. The session token is claimed once, on the transition into playing. A device
// that could not reach its library at that instant - offline, playing a downloaded album - played
// with no token and never asked again, and because only a TOKEN HOLDER heartbeats the session, it
// had no path back either. Measured 2026-07-30 on two of one person's phones: both playing
// different tracks for 70s, and the offline one still going after it reconnected and could
// already see on its own screen that the other device was the active player.
//
// So a non-holder now re-checks on the heartbeat it was already skipping, and this decides:
//
//   'adopt'  the row already names us. We raced our own claim, or reconnected holding it.
//            Carry on; nothing to do but remember we hold it.
//   'stop'   another device holds it AND says it is playing. Two devices are audibly playing at
//            once and we are the one that never asked. Stop.
//   'claim'  anything else - no row at all, or a holder that is stopped or paused. We are the
//            device actually playing, so the token is ours to take.
//
// THE `playing` GATE ON 'stop' IS LOAD-BEARING. The token deliberately persists as last-known
// after a device stops, so another device can still offer "Play here". Without the gate, a token
// left by a phone that finished listening last week would silently kill offline playback the
// moment this phone found wifi - the fix would be worse than the bug.

// AND `playing` HAS TO BE FRESH, not merely set. The holder mirrors the session on a ~4s
// heartbeat while it plays, and the shell forces a snapshot on pause - so a live player's row is
// always seconds old. But a device that is force-quit or crashes mid-song never gets to write
// playing:false, and leaves a row that claims forever that it is playing. Without a liveness
// window, that dead row would stop a phone that had been listening offline the moment it found
// wifi, which is a false stop with no way to see why. A minute is many heartbeats.

const ADOPT = 'adopt'
const STOP = 'stop'
const CLAIM = 'claim'

const LIVE_MS = 60_000

// `row` is the host's session.get reply for this device (null when there is no session), which
// already carries `isActiveHere` - the host comparing the row's activeDeviceKey to the
// authenticated connection, so a device can never be told it holds a session it does not.
// `now` is injected so the window is testable without waiting.
function sessionVerdict (row, now = Date.now(), liveMs = LIVE_MS) {
  if (!row) return CLAIM
  if (row.isActiveHere) return ADOPT
  const age = now - (Number(row.updatedAt) || 0)
  if (row.playing && age < liveMs) return STOP
  return CLAIM
}

module.exports = { sessionVerdict, ADOPT, STOP, CLAIM, LIVE_MS }
