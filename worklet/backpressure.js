// Backpressure, asked the same way of two different stream implementations.
//
// A copy of @peerloom/client/src/backpressure.js (peerloom-client#6). PearTune keeps its own
// shim, older than the shared one, so the fix that landed there did not reach here; this is
// the same seam, so the two can be merged later without changing a caller.
//
// WHY THIS FILE EXISTS. The shim gates its read-ahead on whether the thing it is writing to
// is still holding what it was already given: do not ask the host for another window until
// the player has drained the last one. The obvious way to ask is Node's `writableNeedDrain`,
// and tests run on Node, so that gate looks like it works.
//
// The phone does not run Node. Bare's http response is a streamx Writable, and streamx does
// not define `writableNeedDrain` at all, so the read comes back `undefined` and the gate
// never waits once. PearCinema shipped exactly that: a 2.5 GB film took a TCL from 363 MB
// resident to 2.2 GB in twelve minutes and Android killed the app (measured 2026-08-28).
// Audio is bounded by the range the player asked for, so here the worst case was roughly one
// track resident - which is why nobody noticed for a year, and why this is still worth
// closing.

// LIVE, never latched from a write() return: a queue that filled and then drained
// mid-window would leave a stale flag waiting on a drain event that already fired.
function needsDrain (ws) {
  if (!ws) return false
  if (typeof ws.writableNeedDrain === 'boolean') return ws.writableNeedDrain
  // streamx carries the same question as an inherited static, reachable off the stream's
  // own constructor - no stream library imported into a module that loads on both runtimes.
  const cls = ws.constructor
  if (cls && typeof cls.isBackpressured === 'function') return cls.isBackpressured(ws)
  // Neither signal. Treat as clear rather than deadlock: a runtime that cannot be asked
  // cannot be gated, and a stream stalled for ever is worse than an ungated one.
  return false
}

// Wait until the queue has moved, or the stream died under us. `close`/`error` release the
// wait for the same reason `drain` does - a hangup mid-wait must not park the caller's loop.
function whenDrained (ws) {
  return new Promise((resolve) => {
    // Already gone: `close` fired before we could listen for it, and waiting for an event
    // that has been and gone is the one way this helper could hang.
    if (ws.destroyed) return resolve()
    const go = () => {
      ws.off('drain', go)
      ws.off('close', go)
      ws.off('error', go)
      resolve()
    }
    ws.once('drain', go)
    ws.once('close', go)
    ws.once('error', go)
  })
}

// The gate itself: hold until the consumer has drained, or `stop()` says the work is over.
// Re-checks LIVE on every pass, so a drain that fires between the check and the wait cannot
// strand it.
async function holdUntilDrained (ws, stop = () => false) {
  while (!stop() && !ws.destroyed && needsDrain(ws)) await whenDrained(ws)
}

module.exports = { needsDrain, whenDrained, holdUntilDrained }
