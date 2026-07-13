# PearTune wire protocol v1

## Goal

Define the pairing, authorization and media-transport protocol that lets a PearTune phone reach a self-hosted music library on a PearTune host, with per-device and per-person grant and revoke, and no port forwarding, accounts or third-party servers.

## Tier

**T3.** New wire protocol, new pairing / invite flow, key management, and an auth gate that decides who can reach a library. Per Constitution §2 and §3 this needs a proposal, a rollback path and RCA readiness before code.

## Context

PearTune is the suite's first app whose data does not live on the phones. A host process runs on an always-on machine (Tim's Umbrel for the initial build) next to the music. Everything else in the suite is phone-to-phone; here a host is unavoidable, because a phone cannot dial a folder.

We investigated depending on holesail.io (2026-07-13, see `APP-IDEAS.md`) and rejected it on two grounds. First, its "private" mode admits only a client whose keypair *is the server's own keypair*, derived from a shared seed, and its newer `@holesail/invite` capability is still a single bearer token shared by every client. There is no per-device identity and the only revocation is rotating the seed, which kicks everyone. Second, holesail is AGPL-3.0 / GPL-3.0, while `hyperdht` is MIT.

The primitive we actually need is already in HyperDHT and is MIT: `dht.createServer({ firewall(remotePublicKey) })`. Noise authenticates both ends of every connection, so the host learns the client's real device public key for free, with no bearer token anywhere in the design.

## Scope

### In

1. Host identity and the library id.
2. Pairing: QR handshake over a one-time rendezvous topic (`peartune/pair/1`).
3. Authorization: the host-local grant store, the firewall gate, and revocation semantics including live connections.
4. Media transport: the `peartune/media/1` request/response and byte-stream protocol, and the normalized library API both source adapters must satisfy.
5. Track identity, stable across restarts and shared by every device.
6. The shared ledger (`@peerloom/core` Autobase) carrying resume position, favorites and play counts, and how the host participates in it.

### Out (deliberately, for v1)

- Playlist create / edit and write-back to Navidrome. Playlists stay server-owned and read-only.
- ffmpeg in our image. Transcoding is delegated to Navidrome when it is the source; raw folders direct-play.
- Library-subset scopes and time-limited guest grants. The grant record reserves fields for both so they are not a migration later.
- iOS. Android first.
- Android Auto and Chromecast.

## Protocol

### 1. Identity and ids

| Thing | Derivation |
|---|---|
| Host keypair | `HyperDHT.keyPair(seed)`, seed is 32 random bytes generated on first run, stored `0600` in the host data dir. Never leaves the host. |
| Host public key | `hostKey`, the DHT address clients connect to. |
| Device keypair | Per-device, from `@peerloom/core/identity`. The phone's existing identity, reused. |
| Library id | `libraryId = z32(blake2b('peartune/library/1' ‖ hostKey))`. Deterministic, so the ledger topic survives a host restart. |
| Track id | `trackId = z32(blake2b('peartune/track/1' ‖ libraryId ‖ sourceKey))` where `sourceKey` is the Navidrome track id, or the library-relative file path for a raw folder. |

`trackId` is what the ledger keys on, so it must be stable. It is deliberately *source-scoped*: the same file reached via Navidrome and via a raw folder hashes differently, and switching sources therefore orphans listening state. That is an accepted, warned-about v1 tradeoff - see Decisions (1).

### 2. Pairing (`peartune/pair/1`)

Modeled directly on PearCircle's seeder QR pairing (`pearcircle/proposals/2026-06-22-seeder-qr-pairing.md`), which solved the same problem: a phone pairing with a headless daemon on an Umbrel.

1. The owner opens the host dashboard and clicks **Add device**. The host mints a one-time rendezvous secret `rv` (32 random bytes), joins the Hyperswarm topic `pairTopic = blake2b('peartune/pair/1' ‖ rv)`, and starts a session with a **5 minute TTL**.
2. The dashboard renders a QR encoding `pear://peartune/pair?v=1&rv={z32}&host={z32 hostKey}&name={libraryName}`.
3. The phone scans it, joins `pairTopic`, and connects.
4. **The phone MUST verify `conn.remotePublicKey === hostKey` from the QR before sending anything.** Topic knowledge alone must leak nothing. This is guard (1) from the seeder review: it stops an impostor who merely photographed the QR.
5. Over a Protomux channel with protocol `peartune/pair/1`, the phone sends `deviceHello { deviceKey, label, platform }`.
6. **The host MUST verify `deviceHello.deviceKey === conn.remotePublicKey`** and reject otherwise. Noise already proves the remote key; this stops a device claiming to be another.
7. The host writes a grant (§3), and replies `paired { hostName, libraryId, libraryName, source, ledgerKey }`.
8. The session one-shot closes on success, and expires at TTL otherwise.

Trust for a first pairing is "a session is open on a minted topic, opened by the operator, bounded by 5 minutes" - the same model the seeder ships. The QR carries **no secret material**: `ledgerKey` is handed over only after the connection is authenticated, which keeps the QR small and makes a photographed QR useless after the window closes.

### 3. Authorization

The grant store is **host-local and host-authoritative**. It lives in the host's own Hyperbee and is **never replicated**. This is deliberate: if the allow-list were in the shared ledger, a revoked device could write itself back in.

```
person:{personId}   -> { id, name, createdAt, revokedAt|null }
grant:{deviceKey}   -> { deviceKey, personId, label, platform,
                         scope: 'full' | 'readonly',
                         grantedAt, grantedBy,
                         expiresAt: null,          // reserved, v2 guest grants
                         paths: null,              // reserved, v2 library subsets
                         revokedAt: null,
                         lastSeenAt }
```

The gate, in the firewall hook (returns `true` to **deny**):

```js
firewall (remotePublicKey) {
  const g = grants.get(z32.encode(remotePublicKey))
  if (!g || g.revokedAt) return true
  if (g.expiresAt && now() > g.expiresAt) return true
  if (persons.get(g.personId)?.revokedAt) return true
  return false
}
```

**Revocation must cut off live connections.** The firewall only runs at connect time, so revoking a device that is mid-song would otherwise do nothing until it reconnected. The host keeps `deviceKey -> Set<connection>` and, on revoke, destroys every connection for that device (and for every device of a revoked person). "Revoke stops the music within a second" is a first-class acceptance test, not a nicety.

Revoking a **person** revokes all of their device grants. Revoking a **device** touches exactly one row and disturbs nobody else. This is the requirement holesail could not meet and the whole reason we are building the host ourselves.

### 4. Media transport (`peartune/media/1`)

We do **not** tunnel a raw port. The host exposes a normalized API over the authenticated stream instead. Three reasons: a scoped guest must not be handed Navidrome's entire surface and credentials; scopes have to be enforced per request; and the app should never learn to speak Subsonic, so that the raw-folder adapter is a peer and not a second-class citizen.

Framing is a Protomux channel carrying:

- `req { id, method, params }`
- `res { id, ok, body }` for JSON replies
- `chunk { id, seq, bytes }` then `end { id }` for byte streams, with backpressure
- `err { id, code, message }`

Methods:

| Method | Params | Returns |
|---|---|---|
| `ping` | - | `{ hostVersion, protocol: 1 }` |
| `library.stats` | - | `{ source, tracks, albums, artists, scannedAt }` |
| `library.list` | `{ type: 'artists'\|'albums'\|'tracks'\|'playlists', cursor, limit, filter }` | page + `nextCursor` |
| `library.get` | `{ type, id }` | one entity |
| `library.search` | `{ q, limit }` | `{ artists, albums, tracks }` |
| `art.get` | `{ coverId, size }` | byte stream |
| `media.stream` | `{ trackId, offset?, length?, format?, bitrate? }` | byte stream |

`media.stream` carries `offset` / `length` because it serves **both** seeking and resumable pinned downloads. Getting range support right here is what makes offline pinning cheap later.

An unknown `method` returns `err { code: 'ENOMETHOD' }` rather than dropping the channel, so v1 hosts and v1.1 clients degrade instead of wedging.

### 5. Source adapters

Both adapters satisfy the same interface behind `library.*` and `media.stream`, so the app cannot tell them apart.

- **Navidrome adapter.** Speaks the Subsonic API. Transcoding is delegated by passing the `bitrate` / `format` params straight through to Navidrome, so we ship no ffmpeg and get quality-per-network free (Decisions 4).
- **Folder adapter.** Scans a directory, reads ID3 / Vorbis / MP4 tags, extracts artwork, and direct-plays. Formats Android decodes natively (MP3, AAC, FLAC, Opus, Vorbis) work; exotic formats do not play in v1, which is an accepted gap. It ignores `bitrate` / `format`, so a raw FLAC library over cellular is the one case that still burns real data - the client warns on that combination.

### 6. Ledger

A `@peerloom/core` Autobase per library, multi-writer, topic derived from `libraryId`. This is the part of PearTune that uses the suite substrate rather than the tunnel.

```
resume:{trackId}            -> { positionMs, durationMs, updatedAt, byDevice }   // LWW on updatedAt
fav:{trackId}               -> { starred, updatedAt }                            // LWW on updatedAt
count:{deviceKey}:{trackId} -> { plays, lastPlayedAt }                           // per-writer, summed in the view
```

`count:` uses the substrate's per-writer keyspace rule so two devices never collide on one key, and the apply pass enforces that the `{deviceKey}` segment equals the writing peer's key. The view sums across writers to get a real play count.

**The host is a writer and an always-on seeder for this Autobase.** It never writes state rows. It exists in the ledger for two reasons: so your resume position is reachable when the other phone is off, and so a new device can be admitted as a writer without another phone being awake. Without this, pairing a second device while the first is off would leave it read-only.

## Compat

PearTune has no deployed peers, so nothing can break today. That is precisely why the framing has to be right now, while it is free:

- Protocol version is in the Protomux protocol string (`peartune/pair/1`, `peartune/media/1`). A future v2 is a new string, and a host can serve both.
- The pairing link carries `v=1`.
- Unknown `req.method` returns a typed error rather than dropping the channel.
- Grant records carry `expiresAt` and `paths` as reserved nulls, so v2 guest grants and library subsets are a value change, not a schema migration.
- Link parsing must **cross-reject**: a PearCircle or PearCal invite must not parse as a PearTune pairing link, and vice versa. Unit-tested, as in PearCircle.

## Verify

Per Constitution §5. `npm run verify` = tests + worklet bundle + UI bundle.

Unit:
- Pairing link encode / parse round-trip, and cross-rejection against the other apps' links.
- Rendezvous topic derivation is domain-separated (same `rv` bytes give a different topic than any other app's topic).
- Firewall decisions: unknown key denied, revoked device denied, device of a revoked person denied, expired grant denied, good grant admitted.
- `deviceHello.deviceKey !== conn.remotePublicKey` is rejected.
- `trackId` determinism and source-scoping.
- Ledger apply: a peer cannot write a `count:` row under another peer's key.

Integration, over `hyperdht` testnet, host and client in-process:
- Pair, then `media.stream` a track and compare bytes to the source file.
- Range request: `offset` mid-file returns the correct suffix.
- **Revoke mid-stream and assert the live stream dies, and that reconnect is then denied.** This is the headline acceptance test.

On device (the real gate):
- Android phone + the Umbrel on the LAN, Navidrome installed from the Umbrel store.
- Scan the dashboard QR, pair, browse, play a track, seek.
- Revoke the phone from the dashboard mid-song and confirm playback stops and the device cannot reconnect.
- Pair a second device, confirm resume position and favorites cross over, with the first phone powered off (this is what proves the host-as-ledger-seeder decision).

## Rollback

Pre-release, no users, so rollback is cheap and we should keep it that way until v1 ships.

- Code: the work lives on a feature branch and merges by PR. Revert the branch.
- Host: the Umbrel compose file pins an image digest, exactly as `peerloom-pearcircle-seeder` does. Rolling back is repinning the previous digest.
- Data: the grant store is host-local, so wiping the host data dir resets identity and every grant, at the cost of re-pairing each device. The ledger is keyed by `libraryId`, which is derived from the host key, so a new host identity is a clean new ledger rather than a corrupted old one.
- Protocol: if v1 framing turns out wrong before release, we bump to `peartune/*/2` and drop v1 outright rather than carrying compat we owe nobody.

## Decisions (settled 2026-07-13, Tim)

1. **Track identity: accept source-scoping, warn, remap tool later.** `trackId` stays source-scoped. Switching a library from a raw folder to Navidrome (or back) orphans resume positions, favorites and play counts, and the UI must say so plainly *before* the switch, not after. Rejected: content-hashing every file (a full read of a large FLAC library on a Pi-class Umbrel is slow and disk-punishing) and tag-derived ids (collide on compilations and live albums, and break when you fix a tag typo). A tag-matching remap tool is the escape hatch if this ever actually bites. Track as a TODO, not v1 scope.

2. **The host is a full Autobase writer.** Not a blind seeder. It can therefore admit new devices as writers and serve state when every phone is off, which kills the "pair a second device while the first phone is powered down and it is stuck read-only" problem. The privacy cost is near zero: this machine already holds the music in the clear, and listening history is far less sensitive than PearCircle's location trail, which is what motivated blind seeding there. Rejected: a blind seeder with a separate admission side channel, on the grounds that it adds new protocol surface in the most security-critical part of the design.

3. **A revoked device's `count:` rows stay in the ledger** and keep contributing to totals. Play history is the user's and should not evaporate because they retired an old phone. Purging would mean removing an Autobase writer, which is a much bigger hammer. Revoke is an *access* control, not a history eraser.

4. **Bitrate: auto by network, with a user override.** Original quality on wifi, transcoded to a capped bitrate on cellular, overridable in settings. Free when the source is Navidrome, since it transcodes for us. This is why `media.stream` carries `format` / `bitrate` params. Raw-folder sources direct-play regardless, so on cellular a raw FLAC library is the one case that still costs real data; the UI should warn on that combination.

## Open questions

1. **Dashboard operator-confirm on an incoming pair.** Should the host require the operator to click "allow" when a device appears on the rendezvous topic, on top of the 5 minute window and the pubkey check? PearCircle's seeder deferred exactly this and has not regretted it. Deferring here too, as a named hardening rather than an omission.
