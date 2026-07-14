# Finish the music sources

**Goal** — Make all three things the source picker points at real: folder mode reads
tags, Jellyfin joins Navidrome as a server source, and switching between them stops
throwing credentials away. (Plex was spiked and dropped — see below.)

**Tier** — T2. New persisted config shape (`source.json` v2), one new source kind on
the wire (nothing framing-level changes; the adapter interface is unchanged), and new
dashboard endpoints. No change to the pairing or media wire protocol.

## Why this is a release gate

The source picker shipped, but two of its three targets were half-built. An app-store
user who does not run Navidrome installs PearTune and lands on the folder adapter,
which read filenames and nothing else — no artists, no albums, no artwork, no search
worth the name. That is the first impression of the whole app for exactly the people
who have no server. It could not ship like that.

## Scope

**What changes**

1. **Folder metadata extraction.** The folder adapter reads ID3 / Vorbis / MP4 / FLAC
   tags (via `music-metadata`, MIT) and builds albums, artists and artwork from them.
   Album grouping is inferred from tags + directory layout (see DECISIONS). Artwork is
   an adjacent `cover.jpg`/`folder.jpg` or the embedded picture, resolved lazily and
   cached. A new `groupId()` in `protocol/ids.js` mints stable album/artist ids for a
   source that has none of its own.

2. **Per-kind source config.** `source.json` becomes
   `{ version: 2, active, sources: { navidrome, jellyfin, folder } }`. `active` is a
   pointer; each kind keeps its own row. Switching kinds no longer wipes the other
   kind's credentials. v1 flat configs migrate on read. Passwords still never leave
   the host, and a blank password field still means "leave it alone".

3. **Jellyfin adapter.** Same interface as Navidrome, behind the picker. Username +
   password → a non-expiring access token, held in memory; the password is what we
   persist. No cloud, no refresh loop.

4. **The folder path is verifiable.** The dashboard gets a folder browser
   (`/api/source/folders`) so the operator picks a directory that provably exists in
   the container instead of typing one it cannot. Test on a missing path now throws a
   sentence naming what the container CAN see, instead of reporting "0 tracks". A
   Rescan button, because a folder has no scanner watching it.

5. **Umbrel compose mount fix.** The compose mounted `data/storage/downloads`, which
   is empty on a real Umbrel. It now mounts `home/Downloads` (where the music is,
   matching Navidrome's own app), defaulting the library to the `music` subfolder.

**What does NOT change**

- The pairing and media wire protocol. Adapters are swapped behind an unchanged
  interface (`scan/probe/list/get/search/art/stream`).
- `trackId` derivation. Still source-scoped; switching sources still orphans listening
  state, still warned about before the switch.
- The grant store, auth, revoke — untouched.
- **Plex is not shipped.** Spiked and declined: see DECISIONS. Not on cost of the
  reads (comparable to Jellyfin) but on auth — Plex requires a plex.tv cloud account
  and an Ed25519 JWT that expires every 7 days, needing a rolling cloud refresh for a
  daemon reading a local disk. That is the exact failure mode PearTune exists to
  abolish. Declined on architecture, explicitly NOT on legality (Plex published an
  official API in Sept 2025 and music is exempt from their remote-playback paywall).

## Compat

- **`source.json` v1 → v2** migrates on read (`migrate()` in `host/source.js`), tested.
  Tim's Umbrel has a v1 file; it keeps working, credentials intact. A v2 file written
  by a newer host and read by an older one would be ignored and fall back to
  env/folder — acceptable, and the same posture as any unknown config.
- **A new source kind is not a wire change.** The app talks to the normalized media
  API; it never learns which adapter answers. An old app against a Jellyfin-backed
  host works with no update.
- **`groupId` is not a ledger key.** Album/artist ids are not persisted anywhere
  durable, so their derivation can change later without orphaning anyone. `trackId`
  cannot, and does not.

## Verify

- `npm run verify` (124 tests + both builds). New: `test/folder.test.js` (20),
  `test/browse.test.js` (7), rewritten `test/source.test.js` for v2 + migration.
- Folder fixtures (`scripts/make-music-fixtures.sh`) cover the cases that break real
  scanners: an album split across CD1/CD2, a compilation with no albumartist tag, an
  untagged file, external vs embedded art.
- Folder adapter driven end-to-end over real P2P (`scripts/smoke-client.js`) against a
  host booted on the fixtures: albums/artists/tracks, art, streaming, Range.
- Jellyfin adapter driven against a live server (demo.jellyfin.org): auth, listing,
  album/artist detail, search, exact-byte streaming, Range 206, artwork, the
  cold-restart id-rebuild path. `scripts/smoke-jellyfin.js` for testing against a real
  populated Jellyfin (Tim's, once it has music in it).
- Manual smoke on the TCL against the real Umbrel: folder source, browse the picker,
  play a track, revoke mid-song still stops it.

## Rollback

- Each piece is independent. Revert the folder adapter and it is filenames again;
  revert Jellyfin and the picker has two kinds; revert the compose and re-pin the old
  digest.
- `source.json` v2 is forward-compatible on read (v1 migrates up). Rolling the host
  back to a v1-only build would ignore a v2 file and fall to env/folder — the library
  goes to the default, not dark, and the operator re-picks in the dashboard.

## Open questions

- **Art resizing.** The folder adapter serves original-size covers (no resizer; that
  is a native dep or slow pure JS). Navidrome/Jellyfin resize. If the album grid feels
  heavy on a phone over a slow link, this is the thing to measure and maybe fix.
- **Combined sources** (Navidrome + a folder it never scanned). Still out. `trackId`
  is source-scoped, so a merged library needs a dedup story first. The per-kind config
  is the right shape for it when it comes.
- **`.m3u` playlists** in a folder. Not read. A fine future addition, not this.
