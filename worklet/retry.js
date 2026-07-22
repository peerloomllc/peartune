'use strict'

// Capped exponential backoff for the reconnect loops.
//
// Two of them now: the ACTIVE client (proposal-less fix #121 - a link that dies with the app in
// the foreground is retried instead of sitting "Offline - unreachable" until you relaunch) and,
// since 2026-07-21, every POOL host in a merged blend, which had the same hole one level out.
// The math lives here, pure, so both share it and it is unit-tested without a DHT or a clock.
//
// The shape matters: a host that is simply OFF - or that revoked us - must not become a dial
// every few seconds for the rest of the day, and a phone in a tunnel must not burn its battery
// retrying. Doubling from 5s to a 60s ceiling gets a brief blip back almost at once while
// costing one dial a minute in the pathological case.

const MIN_MS = 5000
const MAX_MS = 60000

// The delay to wait before the NEXT attempt, given the previous one (0 / absent = the first
// retry). Garbage in - null, NaN, negative, Infinity - is treated as "no previous delay"
// rather than propagating: a bad number here would either hammer a host or park a retry
// forever, and neither belongs in a caller's error path.
function nextDelay (prev = 0, { min = MIN_MS, max = MAX_MS } = {}) {
  const lo = Number.isFinite(min) && min > 0 ? min : MIN_MS
  const hi = Number.isFinite(max) && max >= lo ? max : Math.max(lo, MAX_MS)
  const p = Number.isFinite(prev) && prev > 0 ? prev : 0
  if (!p) return lo
  return Math.min(p * 2, hi)
}

// The first `n` delays, for tests and for documenting the ladder in one place.
function ladder (n, opts) {
  const out = []
  let d = 0
  for (let i = 0; i < n; i++) { d = nextDelay(d, opts); out.push(d) }
  return out
}

module.exports = { nextDelay, ladder, MIN_MS, MAX_MS }
