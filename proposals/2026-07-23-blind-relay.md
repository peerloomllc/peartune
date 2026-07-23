# Blind relay - the off-LAN backstop for a genuinely-0%-punch host

## Goal

Make PearTune reach its host **even when the hole-punch never lands** (fully symmetric NAT / CGNAT
on both ends, a ~0%-punch user). The shipped Hyperswarm transport (#154-159) fixes the common
~12% carrier case by retrying forever and holding on, but no retry budget rescues a 0% punch. A
**blind relay** - one public box both ends can reach outbound - is the only thing that turns
"eventually, maybe" into "always". The phone<->host stream stays Noise-encrypted end to end, so the
relay carries only ciphertext plus metadata (which two keys talk, bytes flowing). It is transient
encrypted transit, never a copy of the library.

## Why - who this is for

DECISIONS 2026-07-22 (evening) measured the punch at 12% per attempt on Tim's Pixel over Google Fi,
each failure aborting at a deterministic ~10.5s with code `HOLEPUNCH_ABORTED`. Retries turned
"never" into "usually within a minute". But 12% is the *average*; a user on a genuinely symmetric
NAT sits at ~0% and the persistent swarm never lands. For them the app is simply broken off-LAN,
and the pitch ("your music, anywhere, no VPN") is false. The relay is the floor under that promise.

## Tier

**T3.** It is a new transport path for the live media stream and it introduces PeerLoom-run
infrastructure that carries user traffic (encrypted). Proposal + rollback + RCA readiness required.
It does **not** touch the wire protocol, the grant store, the firewall, or revoke - see below.

## The load-bearing question, resolved against the source

The draft asked: does hyperdht's `relayThrough` compose with Hyperswarm's `swarm.join`, or must the
phone drop to a raw `dht.connect(hostKey, {relayThrough})` fallback? **Answer: it composes natively,
and better than hoped.** Verified in `node_modules/hyperswarm@4.17.0/index.js`:

- The constructor takes `relayThrough` (line 28) and stores it as `toRelayFunction(relayThrough)`
  (line 62). For a plain key that becomes `(force, swarm) => (force || swarm.dht.randomized ? key : null)`
  (line 683) - i.e. **null unless forced**, so direct is always tried first.
- `_connect` passes `relayThrough: this._maybeRelayConnection(peerInfo.forceRelaying)` into
  `dht.connect` (lines 210-214).
- On connect error it sets `peerInfo.forceRelaying = true` and resets attempts when
  `shouldForceRelaying(err.code)` (lines 225-227). That predicate (line 670) fires on exactly
  **`HOLEPUNCH_ABORTED`**, `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS`, and `REMOTE_NOT_HOLEPUNCHABLE` - the
  precise failure our diagnostics recorded.

So Hyperswarm already implements the exact escalation the draft wanted us to build by hand:
**direct-first per peer, and on a hole-punch abort, retry through the relay.** The phone change is
one option on the existing swarm - no raw `dht.connect` fallback, no second media path.

## The other finding: the host needs NO code change

The draft's phase 2 was "host: `dht.createServer({ relayThrough: RELAY_KEY })`". Verifying the
hyperdht relay handshake shows that is **unnecessary and counterproductive**:

- When the phone escalates it puts `relayThrough: {publicKey, token}` in its handshake payload
  (`lib/connect.js:455`). The host's server sees `remotePayload.relayThrough` and relays on that
  alone - `if (relayThrough || remotePayload.relayThrough)` (`lib/server.js:410`). It dials the
  relay itself (`hs.relaySocket = this.dht.connect(publicKey)`, `:664`) using the phone's token.
- `_relayConnection` sets `hs.relayToken = token` (`:663`) **before** the prepunch timer is armed,
  so the holepunch-abort path's teardown - `if (hs.relayToken === null) hs.rawStream.destroy()`
  (`:428`) - is a no-op for a relayed stream, and the successful-pair handler clears the prepunch
  timeout (`:682`). A stock host correctly *sustains* a relayed connection it never configured.
- If instead the host set its own `relayThrough`, `:410` is always true, so it would relay **every**
  connection - burning a relay dial even when the direct punch works. We do not want that.

So the phone requesting the relay is both **sufficient and optimal**, and the direct-first decision
lives entirely on the phone where Hyperswarm already makes it. **No host redeploy is on the critical
path for the relay to work** (any host already on hyperdht 6.33 follows the phone's request). This
removes the host-image / Umbrel-redeploy gate the draft assumed.

## The relay mechanism (blind-relay), precisely

`relayThrough` is not "a plain DHT node forwards by default" - a plain node does **not** relay. It
is [`blind-relay`](holepunchto/blind-relay), a Protomux-channel TURN-like pairing service that
hyperdht drives. On escalation both ends `dht.connect(RELAY_KEY)` and run a `blind-relay.Client`
that `.pair(isInitiator, token, rawStream)`s on a shared token (`lib/connect.js:793-838`,
`lib/server.js:646-705`). The relay matches the two half-connections by token, allocates a UDX
stream pair, and forwards bytes. It never holds a key to the Noise session, so it sees ciphertext
only.

Direct-first is preserved even *after* escalation: `confirmDirectUpgrade`
(`lib/relay-connection.js:20`) watches for a direct path and tears the relay down if a punch later
lands, so a relayed session upgrades itself to direct for free if the network ever allows it.

## The relay NODE (the actual new work)

A small always-on daemon on a box with a **public routable IP** (a VPS - not an Umbrel/Start9,
which are behind home NAT and cannot be the relay). It is:

- A `hyperdht` node listening on a fixed keypair (the **PeerLoom relay key**), plus a
  `blind-relay.Server` whose `createStream` allocates raw UDX streams (`dht.createRawStream()`).
  On each inbound `createServer` connection it calls `server.accept(conn, { id: conn.remotePublicKey })`
  and lets blind-relay pair by token. ~100-150 lines of Node; no Autobase, no per-user state, no
  music - strictly simpler than PearCircle's blind *seeder*.
- **App-agnostic.** One relay key can back PearTune, PearCal, and PearCircle - a blind byte-forwarder
  cares nothing about the app. We build and own it for PearTune first; sharing it later is a config
  change, not a rebuild.
- Deployed with the **seeder-launcher operational pattern** (an always-on Node service, a tiny
  status page showing `server.stats` / `dht.stats.relaying`, a pinned redeploy script per
  `[[deploy-via-runnable-script]]`), but as a plain Node daemon - the relay needs no Bare worklet.
- Its **public key is a baked-in constant** in the app (and available to the suite). One key,
  discovered by nobody, dialed by both ends.
- **Abuse posture for v1:** it forwards ciphertext for anyone who presents a token, so it is an open
  relay by construction. v1 ships with a connection/bandwidth cap and stat visibility; a per-key
  allow-list or accounting is a later iteration, called out in RCA-readiness, not built now.

## What stays byte-for-byte identical

Everything above the socket. The `blind-relay` connection hands back the **same** UDX stream and
`remotePublicKey` a direct `dht.connect` does - identical to why the Hyperswarm swap was tractable.
So Protomux, the PAIR and MEDIA channels, `client.attach`, grant gating, `serveMedia`, the
revoke-kill registry, and streaming are all unchanged. **Only socket acquisition changes**, and only
on the fail path.

## Revoke and the grant model still hold

The host's `firewall` hook runs on the relayed connection exactly as on a direct one (admission is
end-to-end Noise; the relay cannot forge a device key). The `deviceKey -> Set<connection>` revoke
registry destroys a relayed connection the same way it destroys a direct one. The relay weakens
neither of "the two rules that matter most". A relay carries encrypted bytes transiently; the "no
cloud copy of your files" line stays true and should be stated precisely as *transient encrypted
transit, not storage*.

## Phases

1. **Relay node.** Build the `hyperdht` + `blind-relay.Server` daemon. Generate the PeerLoom relay
   keypair (public key -> constant; private key -> the node only). Deploy to a public VPS via a
   pinned redeploy script. **Verify:** two NAT'd test peers that cannot punch each other connect and
   move bytes through the relay (a standalone script on a testnet, then over the real DHT).
2. **Phone.** Add `relayThrough: RELAY_KEY` to the one `new Hyperswarm(...)` at `src/bare.js:1226`.
   Bake the relay public key as a constant. Nothing else - Hyperswarm's `forceRelaying` does the
   direct-first escalation. Surface `dht.stats.relaying { attempts, successes, aborts }` in the
   Settings -> Connection diagnostics (#148) so the escalation is observable. **No host change.**
3. **Verify on a genuinely-0%-punch scenario.** The Pixel on the worst cell NAT, or a forced
   symmetric NAT. Success = it connects **via the relay** when direct never lands, and streams a
   track; and when direct *does* work, `relaying.successes` stays 0 (we did not relay a punchable
   host). Confirm revoke still cuts a relayed phone within a second.

## Rollback

Phase 2 is one option on the swarm: remove `relayThrough` and the phone stops relaying. The relay
node can be taken down independently - with no `relayThrough` requested, nothing ever routes through
it, so a dead relay degrades exactly to today's behavior (0%-punch users stay unreachable, everyone
else unaffected). No wire or grant change to unwind.

## RCA readiness / risks

- **The relay is a single point and an open forwarder.** If it is down, 0%-punch users lose the
  backstop (others unaffected). If it is abused, it burns our bandwidth. v1 mitigations: caps + stat
  visibility; a per-key allow-list is the named next step if abuse appears.
- **Metadata disclosure.** The relay sees device-key <-> host-key pairs and byte volumes. This is
  the standard relay disclosure and matches the "blind" precedent; state it honestly in user-facing
  copy, do not imply zero-knowledge.
- **`swarm.dht.randomized` always-relays.** A phone whose NAT is double-randomized relays every
  connection (not just on force). That is correct (it cannot punch anyway) but worth watching in the
  stats - it is the one case where direct-first yields immediately.

## Verify

`npm run verify` green before every PR. Phase 1 adds a relay-node smoke test (two-peer relayed
connect on a local testnet). Phase 3 is the hardware gate on the Pixel per the manual smoke in
CLAUDE.md, plus the revoke check on a relayed connection.
