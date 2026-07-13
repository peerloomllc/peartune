# PearTune Decisions

Append-only, newest on top. See Constitution §4.

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
