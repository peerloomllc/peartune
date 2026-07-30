// The PeerLoom blind relay - client-side constant + policy (proposal 2026-07-23, phase 2).
//
// RELAY_PUBLIC_KEY_Z is the relay node's public key (z-base32), baked in once the
// relay is deployed to a public VPS (relay/, phase 1 deploy). While it is null the
// phone passes NO relayThrough and nothing is ever relayed - the app behaves exactly
// as it does today. Set it to the string `node relay/index.js` prints on first start.

const z32 = require('z32')

// The deployed PeerLoom relay's public key (DigitalOcean droplet, 2026-07-23). Its
// private seed lives only on the relay box (relay.seed, 0600) + Tim's password manager.
const RELAY_PUBLIC_KEY_Z = 'qshao3eawtzecrt5p7buswr4meyyhw6q6b51qtxazd8wwfdp8uqy'

const RELAY_PUBLIC_KEY = RELAY_PUBLIC_KEY_Z ? z32.decode(RELAY_PUBLIC_KEY_Z) : null

// The direct-first relay policy - the function Hyperswarm calls per outbound connect
// (it accepts `relayThrough` as either a key or a `(force, swarm) => key|null` fn).
// Returns the relay key to route through, or null for a direct-only attempt.
//
//   force      - Hyperswarm sets forceRelaying=true after a HOLEPUNCH_ABORTED (the
//                direct punch failed for this peer this session). This is what makes
//                us direct-FIRST: null on the normal attempt, the key only after a fail.
//   randomized - the phone's own NAT is double-randomized, i.e. a direct punch can
//                never work; relay from the first attempt (matches Hyperswarm's own
//                default gate `force || swarm.dht.randomized`).
//   useRelay   - the user's privacy toggle (Settings -> Connection, default true). Off
//                means pure peer-to-peer: never touch PeerLoom's relay, accept that a
//                0%-punch network simply will not connect.
//   relayKey   - the baked relay key, or null when no relay is configured yet.
//
// Order matters: the toggle and the "is a relay even configured" check gate first, so
// a user who opted out (or a build with no baked key) never relays regardless of NAT.
function relayThroughFor ({ force, randomized, useRelay, relayKey }) {
  if (!useRelay || !relayKey) return null
  return (force || randomized) ? relayKey : null
}

// Whether a library reachable only THROUGH the relay may stream AUDIO right now
// (proposal 2026-07-29-relay-audio-consent). Pure, so the decision is testable away
// from the transport.
//
//   relayed - we OFFERED the relay for this library's connection. Recorded by us at the
//             relayThrough call site, not read off the socket: the phone's own
//             dht.stats.relaying reads 0 while actually relaying, and hyperdht keeps the
//             real flag private. See the proposal's load-bearing question, and the
//             KNOWN LIMITATION note in src/bare.js - offering is not using, so this can
//             be true of a connection that ended up direct. It errs towards asking.
//   consent - the per-library 'ask' | 'allow' | 'deny', default 'ask'.
//
// Returns what to DO, not a boolean, because "cannot play" has two very different
// shapes: one asks the user, the other is a standing no they already gave.
//
//   'play'   - stream it
//   'ask'    - prompt once, then remember (decision 2 + 3)
//   'refuse' - a sticky deny; do not prompt again, the library's settings row is where
//              it gets reversed (decision 3)
//
// NOTE this gates AUDIO ONLY. Browse, search and artwork cross the relay with no
// prompt (decision 1, Tim 2026-07-29): they are kilobytes against audio's megabytes,
// and gating them would mean a hard-NAT user opens a library to an empty screen and a
// dialog - the pairing-prompt problem moved one step later rather than solved. That is
// a DISCLOSED trade, not a silent one; the privacy page says so. Do not "tighten this
// up" by routing art or metadata through here without changing the privacy page too.
function relayAudioDecision ({ relayed, consent }) {
  if (!relayed) return 'play'
  if (consent === 'allow') return 'play'
  if (consent === 'deny') return 'refuse'
  return 'ask'
}

module.exports = { RELAY_PUBLIC_KEY, RELAY_PUBLIC_KEY_Z, relayThroughFor, relayAudioDecision }
