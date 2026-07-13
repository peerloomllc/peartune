# PearTune Decisions

Append-only, newest on top. See Constitution §4.

## 2026-07-13 - NOT WebRTC. HyperDHT for transport, loopback HTTP for the player
Tier: T3 (transport)
Context: WebRTC comes up a lot in the Pear/Holepunch space around streaming
media, so: should PearTune use it instead of "HTTP"?
First, a category error worth naming: **the HTTP in PearTune never touches the
network.** The shim runs on 127.0.0.1 between our Bare worklet and Android's
media player - both on the same phone. The phone-to-host transport is already
P2P (HyperDHT + UDX + Noise). So WebRTC would not replace the HTTP; it would
replace HyperDHT.
Choice: keep HyperDHT for transport and the loopback HTTP shim for the player.
Why WebRTC is a downgrade HERE (it is a fine technology, wrong fit):
1. **It reintroduces servers.** WebRTC needs signaling to exchange offers/ICE
   candidates, plus STUN, plus TURN when holepunching fails. TURN is a relay -
   a server you run and pay for, carrying user traffic. "No servers" is the
   whole pitch. Holepunch's DHT does discovery + holepunching with zero infra.
2. **Its media path is the wrong shape.** WebRTC media channels are RTP: built
   for realtime conversation, and they DROP PACKETS to protect latency. Correct
   for a video call, wrong for a FLAC, where we want exact bytes. You would end
   up on DataChannels instead - a reliable ordered byte stream, i.e. exactly
   what UDX already gives us, with more overhead and a signaling dependency.
3. **It would destroy the auth model.** Everything here rests on Noise
   authenticating the far end AS A PUBLIC KEY, which is what lets the host
   allow-list device pubkeys with no bearer token anywhere. WebRTC identity is
   DTLS fingerprints exchanged over whatever signaling you built, so pairing,
   grants and revocation would have to be rebuilt on a weaker foundation.
When WebRTC WOULD be right, and we should revisit then: (a) a BROWSER client -
browsers cannot open raw UDP sockets, so WebRTC is the only P2P transport
available there; (b) genuinely realtime audio (listen-together, broadcast,
calls), which is what RTP is actually for. Neither is v1.
Alternatives to the loopback shim (the real competitor, not WebRTC): a custom
ExoPlayer DataSource in Kotlin reading straight from the worklet - no socket, no
cleartext exemption, less copying. Rejected for now: real native code per
platform plus a Kotlin-to-Bare bridge, to replace a shim that is already proven.
Revisit if on-device profiling shows the HTTP hop actually costs battery or CPU.

## 2026-07-13 - Protomux message order lives in ONE shared file
Tier: T3 (wire format)
Context: Protomux assigns each message a type id by REGISTRATION ORDER - first
`addMessage()` is type 0, next is type 1. Host and client each registered their
own, in different orders (host: `paired` then `deviceHello`; client the reverse).
Both ends decoded every frame as the wrong type. It fails SILENTLY: the frames
arrive, decode into garbage, and the handler you expected simply never fires, so
pairing hung with no error on either side. The media channel had the same latent
mismatch.
Choice: `protocol/channels.js` owns the registration order and both sides build
channels through its factories. Hand-rolling `mux.createChannel` + `addMessage`
for a PearTune channel is now a bug by definition. New message types append to
the END of the list; inserting in the middle silently renumbers the wire.
Consequences: the ordering can no longer drift between host and app, which are
in different runtimes (Node and Bare) and will be updated on different schedules.

## 2026-07-13 - Pairing dials the host by key; there is no rendezvous topic
Tier: T3 (pairing flow - SUPERSEDES §2 of proposal 2026-07-13-wire-protocol)
Context: the proposal copied PearCircle's seeder QR pairing, where phone and host
meet on a Hyperswarm rendezvous topic derived from a one-time `rv`. That did not
survive contact with the code: Hyperswarm creates its OWN HyperDHT server and
listens on its keypair, so a host running both a Hyperswarm (for pairing) and its
own `dht.createServer` (for media) under one identity had two servers fighting
over the same keypair, and deadlocked.
Choice: drop the rendezvous entirely. The QR already carries the host's public
key, so the phone DIALS THE HOST DIRECTLY by key. `rv` survives as a one-time
pairing TOKEN, presented in the hello to prove the device actually saw the QR.
The firewall gains a narrow exemption: while a pairing window is open it admits
an ungranted device, and `_onconnection` then offers it the pair channel ONLY,
never the media API.
Alternatives: give the pairing swarm a separate keypair (then the phone cannot
verify the host against the QR); keep Hyperswarm and drop our own server (loses
the `firewall` hook, which is the entire auth design).
Consequences: STRICTLY STRONGER than what it replaces. Dialing a HyperDHT key
means Noise authenticates the far end AS that key, so an impostor who
photographed the QR cannot answer the call at all. The seeder's "verify the
remote pubkey matches the QR" guard stops being a check we must remember to
write and becomes a property of the transport. Also simpler: no Hyperswarm in
the host at all until the ledger needs one in milestone 3.
Why the seeder differs: there the PHONE held the secrets and the seeder was
anonymous, so a rendezvous was the only way to meet. Here the host has the
stable public identity. Do not cargo-cult the seeder's flow into a third app
without checking which side is anonymous.

## 2026-07-13 - Bitrate adapts to the network, with a user override
Tier: T1 (client policy; the wire already carries the params)
Context: a FLAC library over cellular is roughly 300MB an album and will stutter,
but always transcoding wastes fidelity on the wifi where most listening happens.
Choice: original quality on wifi, capped bitrate on cellular, overridable in
settings. `media.stream` carries `format` / `bitrate`, which the Navidrome
adapter passes straight through to Navidrome's own transcoder.
Alternatives: always-original (burns data), one fixed user setting (wastes
either data or fidelity, since it cannot know the network).
Consequences: free for Navidrome sources. The **folder adapter has no transcoder
to delegate to**, so a raw FLAC library over cellular is the one case that still
costs real data - the client must warn on that combination.

## 2026-07-13 - Revoke is an access control, not a history eraser
Tier: T2 (ledger semantics)
Context: when a device is revoked, do its `count:` play-count rows leave the
ledger with it?
Choice: they stay, and keep contributing to totals. Play history belongs to the
user and should not evaporate because they retired an old phone.
Alternatives: purge on revoke (means removing an Autobase writer, a much bigger
hammer, and it makes revoke irreversibly destructive); purge only for people and
not devices (the ledger would have to know which grants were "you" vs "a guest").
Consequences: a revoked device cannot reach the library, but its historical
contribution to play counts persists. Say so in the revoke UI so it is not a
surprise.

## 2026-07-13 - The host is a full Autobase writer, not a blind seeder
Tier: T3 (trust model)
Context: PearCircle's seeder is deliberately blind - it stores encrypted blocks
it cannot read. Should PearTune's host be the same?
Choice: full writer. It never writes state rows, but it participates in the
ledger so that (a) your resume position is reachable when every phone is off,
and (b) a new device can be admitted as a writer without another phone awake.
Alternatives: blind seeder (cannot admit writers, so pairing a second device
while the first phone is off leaves it stuck read-only); blind seeder plus a
narrow admission side channel (new protocol surface in the most
security-critical part of the design, which is exactly where not to be clever).
Consequences: the host can read listening history. Acceptable: it is a machine
you own that already holds the music in the clear, and listening history is far
less sensitive than the location trail that motivated blind seeding in
PearCircle. This asymmetry is deliberate and must not be cargo-culted back.

## 2026-07-13 - Track ids are source-scoped; a source switch orphans state
Tier: T2 (key derivation)
Context: `trackId = z32(blake2b('peartune/track/1' || libraryId || sourceKey))`,
where sourceKey is the Navidrome id or the library-relative path. So the same
file reached two ways hashes two ways.
Choice: accept it for v1 and warn in the UI **before** a source switch, not
after. A tag-matching remap tool is the escape hatch if it bites.
Alternatives: content-hash the audio (bulletproof, but a full read of a large
FLAC library on a Pi-class Umbrel is slow and disk-punishing); tag-derived ids
(no rescan cost, but they collide on compilations and live albums, and break
when you fix a typo in a tag).
Consequences: switching a library from raw folder to Navidrome loses resume
positions, favorites and play counts. TODO for the remap tool.

## 2026-07-13 - Build our own host on hyperdht; do NOT depend on holesail
Tier: T3 (auth gate + wire protocol)
Context: holesail.io is a P2P TCP/UDP proxy on the same Holepunch stack, and
looked like it might save us the entire host transport.
Choice: build our own host daemon directly on MIT `hyperdht`, using
`dht.createServer({ firewall(remotePublicKey) })` against a host-local
allow-list. Borrow holesail's *shape* (invite encoding, mode header) clean-room,
take none of its code.
Alternatives: depend on / vendor / fork holesail.
Consequences: rejected on two independent grounds, either of which suffices.
(1) **It cannot do what we need.** Its "private" mode admits only a client whose
keypair IS the server's own keypair, derived from a shared seed; its newer
`@holesail/invite` capability is still one bearer token shared by every client.
No per-device identity, and the only revocation is rotating the seed, which
kicks everyone. We require per-device and per-person grant/revoke.
(2) **Licensing.** holesail and `@holesail/*` are AGPL-3.0, holesail-server /
-client are GPL-3.0. The suite is MIT.
The wheel we would be "reinventing" does not exist: what holesail offers is a
shared-password tunnel, and what we need is authorization. Noise already
authenticates every HyperDHT connection, so the host learns the client's real
device pubkey for free and there is no bearer token anywhere in our design.

## 2026-07-13 - Normalized host API, not a raw port tunnel
Tier: T3 (wire protocol)
Context: the cheap path is holesail-style - tunnel Navidrome's port and let the
phone speak HTTP to it.
Choice: the host exposes a normalized `peartune/media/1` API over the
authenticated stream. Two source adapters (Navidrome/Subsonic, raw folder) sit
behind it, and the app cannot tell them apart.
Alternatives: raw port tunnel.
Consequences: a scoped guest never gets handed Navidrome's whole surface and its
credentials; scopes are enforceable per request; and the app never learns to
speak Subsonic, which keeps the raw-folder adapter a first-class citizen instead
of an afterthought. Costs us an API surface we would not otherwise have written.
