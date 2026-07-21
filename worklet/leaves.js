'use strict'

// PENDING LEAVES - the "I removed this library while its server was off" queue.
//
// Removing a library tells the host so it drops our grant (device.leave, proposal
// 2026-07-20), which is what makes "remove" on the phone actually END access rather than
// leave a live row on someone's dashboard. But that message can only ride a LIVE
// connection. Remove a library while the server is switched off and the phone purges
// itself while the host keeps a live grant forever - the same user action leaving two
// different host states, and the main way stale rows pile up (found by the pair/unpair
// test run, 2026-07-21).
//
// So an undelivered leave is REMEMBERED here and retried on later launches, until it
// lands or it is too old to matter. This list deliberately lives OUTSIDE the per-library
// state: removing a library deletes that directory, so the pending leave cannot live in
// it. It is keyed by hostKey + libraryId, which is all a later dial needs.
//
// Pure list bookkeeping, kept here so it is unit-tested without a disk; bare.js owns the
// file I/O and the dialling. An entry is
// { hostKey, libraryId, libraryName, queuedAt, attempts }.

// Stop retrying eventually. A host that has been unreachable for a month is either gone
// for good or has long since been cleaned up by hand, and a queue that never drains is
// just a slow leak that dials a dead key on every launch.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const MAX_ATTEMPTS = 20

function normalize (list) {
  if (!Array.isArray(list)) return []
  return list.filter(e => e && typeof e.hostKey === 'string' && typeof e.libraryId === 'string')
}

// Remember an undelivered leave. Re-queueing the SAME host replaces the old entry rather
// than stacking a second one: we only ever need to say "this device is gone" once.
function queueLeave (list, entry, now = Date.now()) {
  const next = normalize(list).filter(e => e.hostKey !== entry.hostKey)
  next.push({
    hostKey: entry.hostKey,
    libraryId: entry.libraryId,
    libraryName: entry.libraryName || '',
    queuedAt: now,
    attempts: 0
  })
  return next
}

// Forget a pending leave. Called when it is finally delivered - and, crucially, when the
// user PAIRS THAT HOST AGAIN: without this, a re-pair would be followed by the queued
// leave landing and revoking the grant the user just created.
function dropLeave (list, hostKey) {
  return normalize(list).filter(e => e.hostKey !== hostKey)
}

function bumpAttempt (list, hostKey) {
  return normalize(list).map(e => (e.hostKey === hostKey ? { ...e, attempts: (e.attempts || 0) + 1 } : e))
}

// Drop entries that are past giving up on, so the queue cannot grow forever.
function expire (list, now = Date.now(), maxAgeMs = MAX_AGE_MS, maxAttempts = MAX_ATTEMPTS) {
  return normalize(list).filter(e =>
    (now - (e.queuedAt || 0)) < maxAgeMs && (e.attempts || 0) < maxAttempts
  )
}

module.exports = { queueLeave, dropLeave, bumpAttempt, expire, normalize, MAX_AGE_MS, MAX_ATTEMPTS }
