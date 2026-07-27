// Single-flight WITH a follow-up run.
//
// A plain single-flight ("if a build is running, return that promise") is wrong for the merged
// index, and wrong in a way that hides: a rebuild is requested BECAUSE a host just joined the
// blend, but the build already in flight took its list of hosts before that host connected. So
// the request is answered by a build that structurally cannot contain what it was asked for, and
// the library stays missing from All libraries until something unrelated triggers another
// rebuild - a reconnect, a switch, or an app relaunch. That is the "the Umbrel goes missing for
// 20 minutes and then comes back on its own" shape (TODO, Tim, 2026-07-26).
//
// So a request that arrives mid-build is remembered and re-run once, after. Requests coalesce:
// ten hosts joining during one build cost exactly one follow-up, not ten.

function createRebuildGate (run) {
  let inFlight = null
  let queued = false

  function request () {
    if (inFlight) {
      // Note we still hand back the in-flight promise: the caller wants "the index is being
      // rebuilt", and the follow-up run will emit its own fresh result to the UI.
      queued = true
      return inFlight
    }
    // Start the build NOW, not on the next microtask - a caller that checks `busy` right after
    // requesting must see a build in progress. The async wrapper turns a synchronous throw from
    // run() into a rejection, so one bad build cannot escape the gate's own cleanup.
    inFlight = (async () => run())().finally(() => {
      inFlight = null
      if (queued) {
        queued = false
        // Fire and forget: whoever queued this is long gone, and a failed follow-up must not
        // become an unhandled rejection.
        request().catch(() => {})
      }
    })
    return inFlight
  }

  return {
    request,
    get busy () { return !!inFlight },
    get pending () { return queued }
  }
}

module.exports = { createRebuildGate }
