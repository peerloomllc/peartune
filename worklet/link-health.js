// Which links need attention this tick, and what kind. (Named for the ONE connection per
// library that P2 leaves behind - there is no longer a "pool" tier to be healthy or not.)
//
// THE ASYMMETRY THIS EXISTS FOR (Tim, 2026-07-26): the phone reconnected to one host in
// seconds while another stayed missing for 20+ minutes and then came back on its own. The
// A/B that followed settled it - the fault followed the ROLE, not the host. Whichever
// library was not the ACTIVE one died quietly, because the active connection is repaired by
// ordinary use (every RPC goes through ensureConnected, which re-joins its topic and forces
// a discovery refresh, across 39 call sites) and no other library has such a caller.
//
// P1 of proposals/2026-07-26-one-connection-per-library.md: stop treating them differently
// HERE, before the bigger restructure. Every paired library - the active one included - gets
// one of two things each tick:
//
//   'redial' - no live client. Re-join its topic and restart its nudge (both idempotent).
//              A dead nudge loop can no longer keep a library dark.
//   'probe'  - a live client that traffic has NOT recently proved. Ping it. A socket that
//              died while the worklet was suspended still reads as connected: the nudge
//              stops (it thinks it landed), the blend claims the library is there, and
//              Hyperswarm will not redial because it dedups one connection per peer. A
//              failed probe destroys it, and the close handler restarts the nudge.
//
// The caller dispatches on `action.active` because the two roles still have different
// machinery underneath (joinActiveTopic vs joinPoolTopic) until P2 unifies them. The
// DECISION, which is what this module owns, no longer depends on the role at all.
//
// Split out from src/bare.js so it is testable without a phone, a swarm or a host.

// Every 30s. Frequent enough that a dark host is redialed on the timescale the nudge
// intends, rare enough that a probe is noise next to a music stream. The timer is unref'd in
// bare.js, so it freezes with a suspended worklet - correct, there is nothing to heal while
// the app is not running.
const WATCHDOG_MS = 30000

// A ping that has not answered in 8s means the socket is not carrying traffic. Generous: the
// hosts answer ping in single-digit ms on a LAN and well under a second off-LAN.
const PING_TIMEOUT_MS = 8000

// Traffic in the last 20s counts as proof of life, so a busy connection is never probed.
// This is not just an optimisation, it is what makes probing the ACTIVE connection safe:
// requests and stream chunks share one mux, so a ping issued behind a track's worth of audio
// on a slow link could time out on a perfectly healthy connection - and destroying that
// would cut the music. A connection carrying audio has proved itself by definition.
const PROVEN_WINDOW_MS = 20000

// hosts: the paired host records. activeLibraryId: which one rides the active client (it
// still needs different plumbing, not a different policy). isLive(libraryId) -> truthy when
// that library has a usable client. provenAt(libraryId) -> ms timestamp of the last inbound
// frame on it (0/null if never). now: current time, injected so this stays pure.
// Returns [{ host, libraryId, active, action }].
function linkActions ({ hosts, activeLibraryId, isLive, provenAt = () => 0, now = 0 }) {
  const seen = new Set()
  const out = []
  for (const h of hosts || []) {
    if (!h || !h.libraryId) continue
    if (seen.has(h.libraryId)) continue
    seen.add(h.libraryId)
    const active = h.libraryId === activeLibraryId
    if (!isLive(h.libraryId)) {
      out.push({ host: h, libraryId: h.libraryId, active, action: 'redial' })
      continue
    }
    const at = provenAt(h.libraryId) || 0
    if (now && at && now - at < PROVEN_WINDOW_MS) continue // traffic already proved it
    out.push({ host: h, libraryId: h.libraryId, active, action: 'probe' })
  }
  return out
}

module.exports = { linkActions, WATCHDOG_MS, PING_TIMEOUT_MS, PROVEN_WINDOW_MS }
