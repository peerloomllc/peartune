# Persistent Hyperswarm transport - the connection model PearCircle already proves off-LAN

## Goal

Make PearTune reach its host reliably off-LAN by adopting the connection model its sibling
PearCircle already runs: a **persistent Hyperswarm membership** per host instead of a one-shot
`dht.connect`. Retry the connection in the background until a hole-punch lands, then **hold it
open** with keepalive across network changes, exactly as PearCircle holds phone-to-phone and
phone-to-seeder connections today.

## Why - the evidence, on Tim's own hardware

Measured 2026-07-22 (DECISIONS, same day): on Tim's Pixel over Google Fi, off-LAN, the raw
hole-punch to the host succeeds **~12% per attempt** and each failed attempt aborts at a
deterministic ~10.5s. PearTune tries 4 times over 45s and then shows "can't reach your
libraries". At 12% that is a coin-flip per host per session (both libraries up in only 1 of 6
measured sessions).

PearCircle does not have this problem on the same phone, the same carrier, and the same Umbrel.
The reason is not the network and not a relay (PearCircle has no relay - verified):

| | PearCircle | PearTune today |
|---|---|---|
| transport | `Hyperswarm.join(topic, {server:true, client:true})` | raw `dht.connect(hostKey)` |
| on failure | retries **forever** with backoff (its ConnectionManager) | 4 tries / 45s, then error |
| once connected | held open, keepalive, auto-reconnect on drop | torn down, re-punched next session |
| who dials | both peers, continuously | only the phone, on demand |

Both sit on the same HyperDHT, so each punch is equally (un)likely. Hyperswarm wins by **never
giving up and then holding on**: at 12% per attempt, a background retry lands within roughly one
to two minutes and the connection then survives the rest of the session. The clean proof is that
PearCircle's blind seeder runs on the **same Umbrel** and the phone reaches it the same Hyperswarm
way - if that works off-LAN and PearTune's host does not, the only variable is the transport.

This supersedes the "relay is THE fix" framing from earlier the same day. The relay is still the
only thing that helps a user whose punch rate is genuinely ~0% (fully symmetric NAT on both ends),
but Hyperswarm-persistence is what fixes the common ~12% carrier case without infrastructure.

## Tier

**T3.** It replaces the transport under every host connection - pairing, media, streaming, the
merged pool. It does **not** change the wire framing, the grant store, the revoke guarantee, or
the media protocol. Each host still authorizes each device independently at connect time, and a
revoke still destroys the live connection within a second. The blast radius is *how a socket is
obtained*, not what rides it.

## What stays byte-for-byte identical

This is the reason it is a T3 worth doing rather than a rewrite. A Hyperswarm `'connection'`
event hands back the **same** object `dht.connect` / `dht.createServer` do today: a UDX stream
carrying `remotePublicKey`, Protomux-able exactly as now. So everything above the socket is
untouched:

- `host/server.js` `_onconnection(conn)` - Protomux, the PAIR + MEDIA channels, the grant lookup
  that gates media, `serveMedia(...)`, the `connections` registry that revoke kills.
- `host/media.js`, `host/pair.js`, `protocol/*` - the entire wire.
- `client/index.js`'s media channel setup after a connection opens.
- Audio streaming - same UDX stream, same throughput.

## What changes - only the socket-acquisition layer

**Host** (`host/server.js`): replace `this.dht.createServer({firewall}, onconnection)` +
`server.listen(keyPair)` with a `Hyperswarm({ keyPair, firewall })` that `join`s a per-library
topic `{server:true, client:false}` and forwards `swarm.on('connection', conn => this._onconnection(conn))`.
The firewall option moves onto the swarm; `_onconnection` is unchanged.

**Phone** (`src/bare.js` + `client/index.js`): replace `dht.connect(hostKey)` (single active +
each pool host) with a Hyperswarm that `join`s each paired host's topic `{server:false,
client:true}` and, on `'connection'`, runs the existing media-channel setup. The pool/reconnect
bookkeeping (`ensureHost`, `scheduleReconnect`, `schedulePoolReconnect`, the 4-try/45s budget) is
**deleted** - Hyperswarm's ConnectionManager owns retry, backoff, and reconnect, which is the
whole point. `poolClient(libraryId)` becomes "the live swarm connection for this host, if any".

**Topic derivation**: a deterministic hash of the host public key, so both ends derive it from the
`hostKey` the phone already holds from pairing. No new secret and no new discoverability - anyone
who knows the host key can already `dht.connect` it; the firewall still denies any device without
a grant, so admission is unchanged.

## Multi-host

One Hyperswarm instance, N joined topics (one per paired host). The merged-index rebuild reads
from whichever host connections are currently live - same as today, minus the manual pool dialing.
A host that is unreachable is simply a topic with no current connection; Hyperswarm keeps trying it
in the background and it folds into the blend the moment it lands (the merged:updated path already
handles a host joining late).

## Revoke still holds

Unchanged in mechanism: the `connections` registry destroys the live connection on revoke, and the
firewall denies the reconnect (no grant). One new behaviour to be honest about: a revoked phone's
Hyperswarm will keep *trying* to reconnect (it cannot tell revoke from a network drop - the same
ambiguity the offline lease already lives with). The host rejects every attempt at the firewall,
so access is not granted; the cost is wasted retries. An explicit local "remove library" should
`leave` that topic so the phone stops trying. Battery/data impact of persistent membership is
negligible while the app is foregrounded and in use, which is when a music app is connected.

## Backwards compatibility and migration

Deploy **host first**. A Hyperswarm server with `server:true` runs a DHT server on the host
keypair internally, so an un-upgraded phone doing raw `dht.connect(hostKey)` still reaches it and
still gets a `'connection'` - old phones keep working against a new host. A new phone (topic
client) needs a host that announces the topic, i.e. the upgraded host. So: ship the host image,
confirm old phones still connect, then ship the app. No wire/grant migration - the grant store and
`state` bee are untouched.

## Relation to the relay

Not either/or. This proposal fixes the ~12% carrier case with no infrastructure. The relay
(`relayThrough`, DECISIONS 2026-07-22) remains an **optional later backstop** for the rare user
whose punch never lands - Hyperswarm persistence cannot rescue a 0% rate, only a relay can. Doing
Hyperswarm first means we may never need to run relay infrastructure at all; if a real user reports
0%, the relay is a smaller, well-scoped follow-on.

## Phases

1. **Host onto Hyperswarm.** Swap `createServer` for `Hyperswarm` + topic join; keep
   `_onconnection` verbatim. Verify on-LAN pair + stream + revoke are unchanged, and that an
   un-upgraded phone (raw `dht.connect`) still connects. Ship the host image.
2. **Phone onto Hyperswarm.** Swap `dht.connect` for topic-join on the single active host; delete
   its bespoke retry/reconnect. Verify on-LAN parity, then re-run the 6-sample off-LAN Pixel test
   (the diagnostics screen already measures this) - success is "connects within ~1-2 min and then
   holds", not "coin-flip on open".
3. **Merged pool onto Hyperswarm.** Move the per-host pool to N joined topics; delete
   `ensureHost`/`schedulePoolReconnect`. Verify the blended view fills as hosts land and survives a
   network switch without going empty.
4. **Pairing over the swarm** (optional, or fold into 1-2). Pairing currently rides `dht.connect`
   too; moving it onto the topic gives pairing the same reliability. Lower priority - pairing is a
   deliberate, usually-near-the-host act - so it can stay on `dht.connect` in phase 1 and move
   later.

## Rollback

Per phase, revert the PR: the socket layer is the only thing that changed and nothing persisted
differently, so there is no state to unwind. Because the host's Hyperswarm still accepts raw
`dht.connect`, a rolled-back phone talks to a not-yet-rolled-back host and vice versa - the
migration is reversible in either order after phase 1.

## RCA readiness / risks

- **Streaming over a long-lived connection.** Audio already rides a UDX stream; keepalive holds it
  warmer, if anything. Watch for a stale connection that Hyperswarm believes is live serving a dead
  stream - the media channel's own `onclose` already fails pending requests, but confirm on device.
- **Retry storm on a revoked/removed host.** Mitigated by leaving the topic on remove-library;
  measure background data use with the app idle-but-foregrounded.
- **Topic discoverability.** Argue explicitly in phase 1 that hash(hostKey) exposes nothing beyond
  what the host key already does, and that the firewall remains the sole admission control.
- **Two DHT servers on one keypair deadlock** (the hazard host/server.js already documents): ensure
  the host runs *only* Hyperswarm, never Hyperswarm plus a leftover `createServer`.

## Verify

`npm run verify` green each phase. On-LAN acceptance is unchanged (pair, stream, seek, revoke
cuts within a second). The off-LAN gate is the measurement that motivated this: re-run the
diagnostics on the Pixel over Google Fi and compare against the 2026-07-22 baseline (12% per
attempt, both libraries up 1/6 sessions). Success is a connection that establishes within a
couple of minutes of retrying and then **stays up** while playing, matching PearCircle.
