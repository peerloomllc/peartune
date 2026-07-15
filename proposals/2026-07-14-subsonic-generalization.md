# Generalize the Navidrome adapter to "Subsonic-compatible"

## Goal
Turn our Navidrome-labelled adapter into an honest Subsonic-compatible source: rename the
kind, add OpenSubsonic API-key auth, and degrade (not crash) when a server implements only
a subset of the API — unlocking ~8 servers for near-zero code.

## Tier
T2 — renames a persisted source kind (source.json) and re-scopes `trackId`; adds a new
persisted secret field (`apiKey`). Migration required.

## Scope
**Changes:**
- **Kind rename `navidrome` → `subsonic`.** The adapter, the config kind, `this.kind`
  (so `trackId`'s sourceKind), the picker button ("Subsonic-compatible"), error strings.
  File `host/adapters/navidrome.js` → `host/adapters/subsonic.js`, class
  `NavidromeAdapter` → `SubsonicAdapter`. The server's OWN name still shows in the app via
  `sourceName` ("Navidrome" / "Nextcloud Music" / "Gonic" / …) — the label is the umbrella,
  the header is the truth. No behaviour change on the wire to the phone.
- **API-key auth (OpenSubsonic `apiKeyAuthentication`).** A new optional `apiKey` field on
  the subsonic config. When set, the adapter authenticates with `apiKey=<key>` (plus the
  always-required `c`/`v`/`f`) and sends **no** `u`/`t`/`s`/`p` — the spec forbids mixing
  (error 43). Auth precedence: `apiKey` if present, else the existing token→`p=enc` flow
  (PR #7). `apiKey` is a SECRET (never sent to the browser; blank-on-save means "keep").
- **Graceful degradation.** Optional endpoints that a subset server (Funkwhale) may not
  implement — `getArtists`, `getPlaylists` — degrade to an empty result instead of throwing
  and breaking the whole view. Critical endpoints (`ping`, `getAlbumList2`, `search3`,
  `getAlbum`, `stream`) still throw loudly. (`getScanStatus` already tolerates absence.)
- **Dashboard:** an "API key (optional)" field on the subsonic source form, so the operator
  can paste a key instead of username/password.

**Does NOT change:** the wire protocol to the phone; Jellyfin/folder adapters; the
token→`p=enc` fallback (kept, still the default when no apiKey is given); how `sourceName`
is derived.

**Not a bearer-token violation.** CLAUDE.md's "no bearer tokens, ever" governs the
phone↔host P2P protocol. `apiKey` is a credential the HOST uses to talk to the UPSTREAM
music server — exactly like the Navidrome password we already store, one layer down. No
token is introduced anywhere in the phone↔host design.

## Compat / migration
- **Now is the free moment.** `trackId = hash(NS_TRACK ‖ libraryId ‖ sourceKind ‖ sourceKey)`.
  Renaming the kind changes every trackId — but the milestone-3 ledger does not exist yet,
  so nothing durable (resume/fav/count) is keyed by trackId today. The rename orphans
  nothing. After milestone 3 the same rename would wipe everyone's history; doing it now is
  the honest, cheap choice.
- **source.json migration.** `migrate()` maps `active: 'navidrome'` → `'subsonic'` and
  `sources.navidrome` → `sources.subsonic`, for both the v1 flat shape and the v2 shape.
  Tim's Umbrel has a live config; it keeps working, credentials intact, after upgrade.
- **Env / CLI.** `PEARTUNE_NAVIDROME_*` and `--navidrome` are kept (people have them set)
  but now build a `subsonic`-kind source.
- **Old app peers:** unaffected — the phone never sees the kind string; it gets normalized
  tracks and `sourceName`.

## Verify
- `npm run verify` green (unit tests updated + added: apiKey auth wire format, apiKey never
  sends `u`, graceful-degrade returns empty, migration navidrome→subsonic, trackId now
  subsonic-scoped).
- **Real hardware:**
  - (a) **Navidrome regression** — after the rename, the token/password path still browses
    and streams on the TCL. (Navidrome authenticates Subsonic clients with username +
    password/token; its "API Keys" tab is for plugins, not client auth.)
  - (b) **apiKey path — against Nextcloud Music**, which implements `apiKeyAuthentication`.
    Configure the subsonic source with the Music-app generated key in the `apiKey` field and
    NO username/password → the adapter sends `apiKey=<key>` (no `u`) → browse, art, search,
    stream on the TCL. (This is the same generated key the p=enc fallback used in PR #7; the
    new path sends it as `apiKey` instead of `u`+`p=enc`.)
  - (c) confirm the existing Nextcloud Music **password** path (p=enc fallback) still serves,
    so we did not regress it.

## Rollback
- Revert the branch. The only persisted change is the source.json kind string; a
  reverse-migration is not needed because the pre-change code still reads a `navidrome`
  kind, and a host that rolled back would re-migrate nothing (it never wrote `subsonic`).
  If a box already saved `subsonic`, rolling back leaves an unrecognized kind → the store
  falls through to env/folder (fail-safe, never a crash), and re-saving from the dashboard
  restores it. Worst case is a re-entered source, never a dark library.

## Open questions
- Should the picker read "Subsonic-compatible", "Subsonic server", or keep "Navidrome" as
  the friendly primary with a subtitle? (Proposing "Subsonic-compatible".)
- Do we probe `getOpenSubsonicExtensions` to confirm apiKey support before using it? Leaning
  NO: the operator explicitly pasted a key; if it is wrong the call fails with a clear error
  (42/44), which is simpler than a probe round-trip.
