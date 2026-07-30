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


// --- the stuck dial (Tim, 2026-07-30) ---------------------------------------
//
// The watchdog above cannot see this one, and the distinction is the point: 'probe' is for a
// connection that is WIRED UP to a client and may have died quietly. A stuck dial never got that
// far - hyperswarm booked it in _allConnections at dial time and it never opened - so there is no
// client to probe and no traffic to prove. Meanwhile that booking makes _connect() return early
// for the peer, so every redial and every discovery refresh is a no-op. Left alone it never
// recovers; only a fresh process does, which is why it presented as "reopen the app and it works".
//
// OBSERVED, not theorised - Tim's Pixel, 2026-07-30, after Android's cached-app freezer held the
// process for ~13 minutes across two freezes:
//     nudge:link {"conns":1,"live":0}
//     method:failed {"method":"reconnect","err":"could not reach the host"}
//
// The decision lives here, away from the swarm internals, so it can be tested without a phone.
//
//   suspended - this tick arrived far later than scheduled, so the worklet was not running in
//               between. Anything booked before that is dead whatever it looked like, so clear it
//               AT ONCE: that is what makes the app connect when opened rather than ~40s later.
//   held      - the backstop. A booking that has simply sat un-opened for holdMs. Not zero,
//               because a hole-punch legitimately in flight is indistinguishable from here and
//               off-LAN punches have been measured at 8-28s; aborting one of those would break a
//               connection that was about to succeed.
//
// Returns 'suspended' | 'held' | null.
function stuckDialAction ({ hasStuck, stuckSince = 0, lastTickAt = 0, now = 0, suspendGapMs, holdMs }) {
  if (!hasStuck) return null
  if (lastTickAt > 0 && now - lastTickAt > suspendGapMs) return 'suspended'
  if (stuckSince > 0 && now - stuckSince >= holdMs) return 'held'
  return null
}

module.exports = { linkActions, stuckDialAction, WATCHDOG_MS, PING_TIMEOUT_MS, PROVEN_WINDOW_MS }
