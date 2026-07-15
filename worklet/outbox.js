// The offline write-queue (milestone 3, phase 5).
//
// State writes made while the host is unreachable - favoriting a track, saving a resume
// position, counting a play - are queued here and replayed in order on the next connect.
// Nothing here touches the network or the disk; it is the pure queue logic, so it is
// unit-testable and the worklet just wraps it with fs + the client.
//
// Coalescing: for a favorite or a resume position, only the LATEST write for a given
// target matters - replaying an older "favorited: true" after a newer "favorited: false"
// would resurrect it. So those REPLACE any earlier queued write for the same target
// (last-writer-wins, which is exactly how the host stores them). A play count is
// different: each bump is a distinct play, so bumps ACCUMULATE and are never coalesced.

const OUTBOX_MAX = 500 // a backstop against unbounded growth if a device stays offline for a very long time

// The coalescing key for an entry, or null for entries that must never be merged.
function entryKey (e) {
  if (e.method === 'fav.set') return `fav:${e.params.kind}:${e.params.id}`
  if (e.method === 'resume.set') return `resume:${e.params.trackId}`
  return null // count.bump (and anything else) accumulates
}

// Append `entry` to `queue`, replacing an earlier entry with the same coalescing key.
// The replacement keeps the NEW value but drops to the back (newest position), which is
// fine: order only matters across DIFFERENT targets, and those are independent.
function coalesce (queue, entry) {
  const key = entryKey(entry)
  const next = key ? queue.filter(e => entryKey(e) !== key) : queue.slice()
  next.push(entry)
  // Oldest-out if we somehow blow the cap (a very long offline stretch of distinct plays).
  return next.length > OUTBOX_MAX ? next.slice(next.length - OUTBOX_MAX) : next
}

// Map a queued entry to the client method that replays it. Returns null for an unknown
// method (defensive: a queue written by a newer app version, then downgraded).
function clientCall (client, entry) {
  if (entry.method === 'fav.set') return () => client.favSet(entry.params)
  if (entry.method === 'resume.set') return () => client.resumeSet(entry.params)
  if (entry.method === 'count.bump') return () => client.countBump(entry.params)
  return null
}

module.exports = { entryKey, coalesce, clientCall, OUTBOX_MAX }
