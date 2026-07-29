# Scoping: a direct connection to a Start9 host via `bindPortRange`

**Status:** scoping, not accepted. **Tier:** T2 (packaging + a small additive host option; no
new trust boundary - see Security).
**Question:** what would it actually take to stop every Start9 user's music crossing our relay?

## The problem, measured

PearTune runs on StartOS 0.4.0 and works. It works entirely through the blind relay.

| Condition | Relay bytes, playback minute | Idle baseline |
|---|---|---|
| Pixel on home WiFi | +5,409,600 | ~60 KB/min |
| Pixel on cellular | +2,126,169 (+346,747 tail) | ~40 KB/min |

The punch fails in **both** directions, so this is not the same-LAN hairpin the 2026-07-18 note
described - that note had cellular punching reliably. Every byte between any phone and a
StartOS 0.4 host crosses the droplet, at ~5 MB/track, on the $4 / 500 GB tier whose binding
constraint is already bandwidth. The cost scales with **listening**, not with user count.

Why 0.4 is worse than Umbrel: Umbrel runs the host with `network_mode: host`, so there is
exactly one NAT between the host and the internet - the home router - which HyperDHT punches
through routinely. On StartOS every package sits in an unprivileged LXC container on `lxcbr0`
(`10.0.3.0/24`, `lxc.net.0.type = veth`), so there are **two** NATs in series. There is no
host-networking option anywhere in `@start9labs/start-sdk` 2.0.9.

## The candidate fix

`MultiHost.bindPortRange` / `Effects.bindRange` is the only raw-UDP door in the 0.4 SDK:
*"a contiguous range of **UDP+TCP** ports"*, documented for coturn / RTP / SIP, with the
external range mapped onto the internal by offset and **one nft rule per chain** covering the
range. The single-port `bindPort` is protocol-typed (`http`/`https`/`ws`/`wss`/`ssh`/`dns`
with `addSsl`/`secure`), i.e. TCP and TLS only, so it cannot carry the DHT.

The idea: pin the host's DHT UDP port, forward it 1:1 on the box, and let the phone reach a
predictable port - collapsing the inner NAT so the box behaves like the host-networked Umbrel
case.

## What is already verified

- **The DHT port is cleanly pinnable.** `new HyperDHT({ port: 49999 })` binds exactly 49999;
  `new HyperDHT()` binds a random port per process (36600 / 42742 / 59270 over three runs -
  the `opts.port || 49737` default at `hyperdht/index.js:27` is a preference that does not
  survive). So the host side is a small additive change.
- **The published image can be reused as-is.** The 0.4 SDK takes
  `images.<id>.source.dockerTag`, so `ghcr.io/peerloomllc/peartune-host:0.2.36` can be pinned
  directly - **no runtime rewrite**, which removes the largest thing anyone would fear here.
- **The box supports it.** `bindPortRange` landed in SDK 2.0.0 / StartOS 0.4.0-beta.10;
  `returned-feline.local` is on released 0.4.0.
- **Constraints:** `numberOfPorts` is 2-500 (a single port is pushed at `bindPort`), the range
  is allocated atomically, and a partial collision is a hard error. So we request 2 and use the
  first.

## THE RISK THAT DECIDES THIS, and it is not the packaging

**A port forward may fix inbound without fixing the punch.**

Holepunching needs the container's **outbound** UDP to leave from the *same* external port that
inbound arrives on. `bindPortRange` is documented as installing forwarding rules - i.e. DNAT for
traffic coming *in*. If the container's outbound packets are still SNATed to an arbitrary source
port by `lxcbr0`, then the mapping stays endpoint-dependent, the punch keeps failing, and the
relay keeps carrying everything. The forward would only help a peer that dials the port
explicitly, which is not how HyperDHT connects.

Nothing in the SDK docs says whether the rule is symmetric. **This is unknown, it is the whole
question, and it is cheap to answer** - which is why the plan below spends a probe on it before
anything else.

## Plan

### P0 - the probe (do this first, alone)

A throwaway 0.4 package whose only job is to answer the SNAT question. Scaffolded already via
`start-cli s9pk init-package`; it reuses the GHCR image by `dockerTag`, sets a fixed
`PEARTUNE_DHT_PORT`, declares `bindPortRange({ internalStartPort: N, externalStartPort: N,
numberOfPorts: 2 })`, and exports it with `sdk.createRangeInterface`.

**Acceptance:** pair the Pixel and play a track, on home WiFi *and* on cellular, while watching
`relay:stats`. Success is relay bytes staying at the ~40-60 KB/min idle baseline through a full
playback minute. Anything resembling the +2.1 MB / +5.4 MB spikes above means the punch is
still failing and **the whole idea is dead** - at which point the honest options are to ship
Start9 relayed, or not ship it.

Cost: small. The scaffold exists, the image is reused, and the acceptance test is one already
run twice today.

**Measure the byte counters only after the minute containing playback has closed.** A reading
taken mid-window looked flat today and nearly produced the wrong verdict.

### P1 - the host option (only if P0 passes)

`PEARTUNE_DHT_PORT` -> `new HyperDHT({ port })`, defaulting to today's behaviour when unset.
~10 lines plus a test. Additive, and useful beyond Start9: any deployment that wants a
predictable port for a router forward can use it.

### P2 - the native 0.4 package (only if P0 passes)

The conversion route cannot do this: a converted v1 s9pk carries a 0.3.5 manifest and cannot
call SDK 2.x effects at all. A native package is therefore **mandatory**, not a preference.

It also fixes a defect found today independently: the converted package has **no LAN or Tor
address** in 0.4's address model (`package host peartune address <id> list` is empty for every
host id), so its dashboard is unreachable through StartOS on the LAN. A native package binds
8741 properly in `setupInterfaces()` and gets that back.

Scope: port the four 0.3.5 procedures (config / health / migrations / properties) into the
SDK's model, mount `/data`, health check, backup, and a migration for anyone on the 0.3.5
package. Bounded by the fact that the runtime image is unchanged.

### P3 - registry publish (unchanged)

Already scoped in `start9/README.md`: v2 s9pk, mandatory `commitment`, non-empty `signatures`,
a real base64 icon, and a **merge-aware** generator so one write does not delist PearCal and
PearCircle from the shared 0.4 document.

## Security

No new trust boundary. The forwarded port carries the same Noise-authenticated, firewall-gated
HyperDHT traffic the host already exposes on Umbrel with `network_mode: host` and on every
desktop install. The grant store stays host-local, revocation is unchanged, and nothing new is
listening that was not listening before - it is reachable on a predictable port instead of an
unpredictable one. That is why this is T2 and not T3, and it is the opposite of the
`worklet/shim.js` LAN-bind idea (proposal 2026-07-26 casting), which *would* have created an
unauthenticated endpoint.

## Alternatives

- **Ship Start9 relayed.** Works today. Costs PeerLoom bandwidth that grows with engagement,
  which is the wrong direction for a cost to grow. Defensible only while Start9 users are few.
- **Do not ship Start9.** Its registry has no music server left on a stock box - the 0.4.0
  upgrade removed Jellyfin - so the audience was always small. Bundling the demo tracks (PR
  #253) is what makes a Start9 install useful at all.
- **Patch hyperdht** to announce an overridden local address. Investigated and rejected the
  same day: a core-dependency patch carried forever, and experiments B and D showed the
  local-address mismatch is not what breaks the connection anyway.
