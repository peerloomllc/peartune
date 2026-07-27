// Which pool hosts need attention this tick, and what kind.
//
// THE ASYMMETRY THIS EXISTS FOR (Tim, 2026-07-26): the phone reconnected to one host in
// seconds while another stayed missing for 20+ minutes and then came back on its own. That
// is not a punch-rate difference, it is structural. The ACTIVE host is kicked by ordinary
// use - every RPC goes through ensureConnected(), which re-joins its topic and forces a
// discovery refresh - so any tap on the app retries it. A POOL host has no such caller: its
// only driver is its own nudge timer, and that timer stops on its own (a tick outside merged
// mode, or a client that READS live because its socket object is not destroyed). Once it
// stops with the host still dark, nothing restarts it until the app relaunches, so recovery
// falls back to Hyperswarm's built-in 10-minute rediscovery - which is exactly the 20 minutes
// that was observed.
//
// So each tick, every non-active paired host gets one of two things:
//
//   'redial' - no live client. Re-join its topic and restart its nudge (both idempotent).
//              This is what makes a dead nudge loop unable to keep the host dark.
//   'probe'  - a live client. Ping it. An idle pool connection is never proved by traffic
//              the way the active one is, so a socket that died while the worklet was
//              suspended still reads as connected: the nudge stops (it thinks it landed),
//              the merged view claims the library is there, and Hyperswarm will not redial
//              because it dedups one connection per peer. A failed probe destroys it, and
//              the close handler restarts the nudge.
//
// Split out from src/bare.js so the decision is testable without a phone, a swarm or a host.

// Every 30s. Frequent enough that a dark host is redialed on the same timescale the nudge
// intends, rare enough that the probe RPC is noise next to a music stream. The timer is
// unref'd in bare.js, so it freezes with a suspended worklet - correct, there is nothing to
// heal while the app is not running.
const POOL_WATCHDOG_MS = 30000

// A ping that has not answered in 8s means the socket is not carrying traffic. Generous: the
// hosts answer ping in single-digit ms on a LAN and well under a second off-LAN, and the cost
// of a false positive is one reconnect, not a user-visible failure.
const POOL_PING_TIMEOUT_MS = 8000

// hosts: the paired host records. isLive(libraryId) -> truthy when that host has a usable
// client right now. Returns [{ host, libraryId, action }].
function poolActions ({ merged, hosts, activeLibraryId, isLive }) {
  // Outside merged mode nothing reads the pool, so there is nothing to keep alive.
  if (!merged) return []
  const seen = new Set()
  const out = []
  for (const h of hosts || []) {
    if (!h || !h.libraryId) continue
    // The active host is not a pool member - it rides the active client and its own nudge.
    if (h.libraryId === activeLibraryId) continue
    if (seen.has(h.libraryId)) continue
    seen.add(h.libraryId)
    out.push({ host: h, libraryId: h.libraryId, action: isLive(h.libraryId) ? 'probe' : 'redial' })
  }
  return out
}

module.exports = { poolActions, POOL_WATCHDOG_MS, POOL_PING_TIMEOUT_MS }
