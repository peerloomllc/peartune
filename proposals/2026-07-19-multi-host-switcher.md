# Multi-host: the library switcher (step 1 of 2)

**Goal** — let one phone pair to more than one host (an Umbrel *and* a Start9,
say) and switch between them like Plexamp switches servers. One library is
active at a time; you manage the set from Settings.

**Status (2026-07-19):** Implemented. Worklet layer (host list + per-library
state + `listHosts`/`switchHost`/`removeHost`) and the Settings Libraries UI are
both in, `npm run verify` green (334 tests). One piece is on-device follow-up: the
"buffered track drains, then playback auto-advances into the new library's queue"
continuity across a live switch — a track already playing is left untouched
(music never stops) and the new library's saved queue loads when nothing is
playing, but stitching the two while a player is live is ExoPlayer queue surgery
to validate on the TCL, not blind-coded. Everything else (list, switch, add,
remove, browse swap) is done.

This is deliberately **switcher-first**. The full "gateway to multi-source"
vision — connect to every host at once and present one blended library — is
step 2 (its own proposal). The switcher is the small, safe first half, and the
one piece of real work it forces — namespacing the offline caches by library —
is exactly the groundwork the merge would need anyway. Nothing here is thrown
away when merge lands.

**Tier** — **T2.** This is a *client-side storage + UX* change. It does **not**
touch the wire protocol, the grant store (still host-local, never replicated),
the revoke guarantee, or anything host-side. Each host keeps authorizing this
device independently, exactly as today. There is no new security boundary — a
phone presenting one identity to two hosts is already what re-pairing does; we
are just keeping both records instead of overwriting.

Decisions confirmed with Tim (2026-07-19):
- **Switcher first, merge later.**
- **Settings-only management** — no host indicator on the Library tab; the list,
  switch, add, and remove all live under Settings › Libraries.
- **Switching swaps the queue but lets the buffered track play out** — a switch
  should never abruptly kill the music (same stance as graceful-reconnect,
  2026-07-14).

---

## What already exists (so the hard layers need no change)

The protocol and identity layers are already multi-host-safe; the single-host
assumption lives entirely in two files.

- **Device identity is host-independent.** One keypair *is* the account, kept
  across unpair (`src/bare.js:118-134`, `:1262`). The same phone presents the
  same key to N hosts with zero protocol or host-side change — each host gates
  it on its own.
- **IDs can't collide across hosts.** `libraryId = hash(hostKey)` and every
  track/album/ledger id is namespaced under it (`protocol/ids.js`). A track on
  the Umbrel and one on the Start9 already have distinct ids — so a per-library
  cache directory is a *move*, not a redesign.
- **The pair link already fully self-describes one host** (`{rv, hostKey, name}`,
  `protocol/link.js`). N links → N host records is a storage-model change, not a
  wire change.
- **`PearTuneClient` is a plain instantiable class** (`client/index.js`) — no
  singletons inside it; the shim already exposes `setClient()`
  (`worklet/shim.js:306-315`) as the seam for swapping which client is live.

So the single-host code is concentrated in exactly two places:

- **`src/bare.js`** — `hosts.json` (plural name, singular content!) holds *one*
  object (`:33`, `loadHost`/`saveHost` `:136-147`); module globals
  `client`/`currentHost`/`connected` (`:82-88`); a second `pair()` silently
  *overwrites* the first (`:489-516`); every media call funnels through one
  `ensureConnected()` (`:414-436`).
- **`src/ui/App.jsx`** — one `state.host`, pairing is a hard wall
  (`if (!state.host)` `:1106-1113`), unpair wipes everything (`:832-858`).

Plus the one genuinely new chunk of work: **the offline caches
(favorites/playlists/queue/pins/lease/outbox + audio + art) are flat, not
namespaced by host** (`src/bare.js:33-70`, `purgeAll` `:307-313`).

## Design

### 1. `hosts.json` becomes a list (with a v1→v2 migration)

Today `hosts.json` is one object `{ hostKey, libraryId, libraryName }`
(`src/bare.js:505-512`). It becomes:

```json
{
  "version": 2,
  "hosts": [
    { "hostKey": "…", "libraryId": "…", "libraryName": "…", "addedAt": 0 }
  ],
  "activeHostKey": "…"
}
```

**Migration** (pure, on load): if the file has a top-level `hostKey` and no
`hosts` array, it's v1 — wrap it as `{ version:2, hosts:[old], activeHostKey:
old.hostKey }`. Identity and device-name settings stay at the account level
(`identity.json`, `settings.json` are untouched — a device has one name across
all its libraries).

New worklet RPCs, thin wrappers over the list: `listHosts()`,
`switchHost(hostKey)`, `removeHost(hostKey)`. `pair()` (`:489`) stops
overwriting — it **appends** (dedupe by `hostKey`; re-pairing a known host just
refreshes its record) and sets it active.

### 2. Connection: lazy, one live client, swapped via the shim seam

A switcher only ever needs one host live at a time, so we stay lazy. Keep a
`Map<hostKey → PearTuneClient>` (all sharing the one DHT + the one keyPair);
`ensureConnected()` (`:414`) reads the **active** host instead of the sole host,
builds/reuses that host's client, connects it, and points the shim at it
(`shim.setClient(client)` — the seam already exists). `switchHost()` is just
"set active, then `ensureConnected()`."

### 3. Switching swaps the queue but drains the buffered track

Playback is decoupled from the control connection — audio comes off the shim's
player/cache, not the live DHT channel. So on switch:

- The **active client swaps immediately** for all *new* requests: browse, art,
  next-track, and the newly-loaded queue are the new host's at once.
- The **previous connection is left to drain** — if a track from the old host is
  still streaming (not fully buffered), its connection stays alive until that
  track ends, then closes. A fully-buffered track needs nothing; it just plays
  out of the player.
- The **new host's saved `queue.json` loads**, but the currently-playing item is
  detached and plays to completion; when it ends, the queue advances into the
  new host's tracks.

This is the same "a transport change must not stop the music" principle as
graceful-reconnect — a switch is an *intentional* transport change, so it reuses
that decoupling rather than fighting it.

### 4. Per-host STATE gets namespaced; the blob caches stay shared (refined during build)

Per-host **state** moves under `DATA_DIR/lib/<libraryId>/`: `favorites.json`,
`playlists.json`, `queue.json`, `pins.json`, `lease.json`, `outbox.json`.
Account-level state (`identity.json`, `settings.json`, `hosts.json`) stays at the
root.

The **audio and art BLOB caches stay shared at the root** — a refinement from the
original "namespace everything." The reasoning, which only became clear while
wiring it: track/art ids are *already* `hash(libraryId + …)`, so a shared cache
can never serve one host's bytes for another's request (no collision), the bytes
**de-dupe** across libraries, and — the load-bearing reason — a track that is
**mid-play when you switch keeps streaming from the same cache object**. If we
re-pointed the audio cache to a new dir on switch, an in-flight (not-yet-fully-
buffered) track would miss and stall — breaking the exact "keep the buffered
track" behavior we chose. Sharing the blobs sidesteps that entirely. Removal
still reclaims a host's downloads: `removeHost` deletes that library's pinned
audio by id (ids are host-unique) and drops its state dir; its plain-LRU bytes
age out under the cap.

**Migration** (one-time, on first multi-host load): the v1 `hosts.json` upgrades
to a one-element list, and the six legacy flat state files move into that host's
`lib/<libraryId>/` dir. The shared audio/art dirs don't move.

The old `purgeAll()` splits in two: **`removeHost(hostKey)`** purges just that
library's state dir + its downloaded audio and drops it from the list (identity
kept); **`forget()`** still forgets *everything* (all libraries + shared caches +
identity untouched — same as before).

### 5. UI: pairing is no longer a wall; Settings grows a Libraries section

- The wall (`App.jsx:1106`) becomes: **zero** hosts → pairing/onboarding screen;
  **≥1** host → the app, with the active library loaded.
- `onPaired` (`:876`) appends to the list and sets active instead of replacing
  `state.host`.
- **Settings › Libraries**: the host list (active one marked), tap a row to
  switch, **"Add library"** (opens the same pairing flow, additive), and per-row
  **"Remove"** (per-host unpair — distinct from the existing account-level
  reset). Unpair copy stops being global ("forget everything") and becomes
  "Remove *this* library."
- Switching reloads source/stats/now-playing for the new host and clears
  transient browse state — but does **not** trip the graceful-reconnect "lost
  the connection" banner (a switch is intentional, not a drop).

### 6. Nothing host-side, nothing on the wire

No adapter, gate, grant, or dashboard change. No new protocol method. The host
never learns it is one of several — it only ever sees a device key connect and
authorizes it, exactly as today.

## Security review

- **Grant store stays host-local and never replicated.** Untouched — this
  proposal adds no host code at all. ✓
- **Revoke is unchanged and still instant, per host.** Revoking this phone on the
  Umbrel cuts its Umbrel connection immediately and denies new Umbrel access; the
  Start9 pairing is a *separate* grant on a *separate* host and is unaffected —
  which is correct (two independent operators, two independent decisions). If the
  *active* host revokes mid-song, the phone gets the normal graceful-reconnect
  banner for that library; switching to another paired library still works.
- **One identity to N hosts is not new exposure.** A host only ever learns the
  device public key (as today). The same key appearing on two hosts is inherent
  to having one identity and is already true the moment you re-pair; we are only
  persisting both records. Both hosts here are Tim's own.
- **Cache isolation by `libraryId`.** Namespacing keeps one library's favorites,
  queue, pins, and cached audio from bleeding into another's views. Not a trust
  boundary (same user throughout) but a correctness one — a switch must show the
  right library's state.
- **No bearer tokens introduced.** Still pure Noise auth per host. ✓

## Verify

- **Unit:** `hosts.json` v1→v2 migration (pure fn); list add/dedupe/remove and
  active-host selection; cache-path resolution by `libraryId`; the legacy
  flat-file → `lib/<libraryId>/` relocation.
- **Hardware (TCL + Umbrel + Start9):**
  1. Pair the TCL to the Umbrel; browse, play, favorite a track.
  2. From Settings › Libraries, **Add library** and pair the Start9 — confirm the
     Umbrel record is *kept* (both listed), not replaced.
  3. Switch to the Start9: browse shows the Start9's library; the Umbrel track
     that was playing **plays out its buffer**, then the Start9's queue advances.
  4. Switch back to the Umbrel: its favorites and queue are **intact** (proves
     namespacing).
  5. Revoke the TCL on the Umbrel while it's the active library: graceful-
     reconnect banner for the Umbrel; **switching to the Start9 still works**.
  6. **Remove** the Umbrel library: its `lib/<libraryId>/` cache is purged, the
     Start9 is untouched, and the device identity is kept (re-adding the Umbrel
     doesn't re-pair from scratch beyond a normal pair).
- **Gate:** `npm run verify` green.

## Out of scope (→ step 2 and later)

- **The merged/blended library** — connecting to all hosts at once and presenting
  one unified artist/album list. This is the "gateway to multi-source" payoff and
  its own proposal; the per-library caches here are its foundation.
- Cross-host search and a queue that *interleaves* tracks from multiple hosts.
- A Library-tab host indicator/switcher (Settings-only for v1).
- Per-host device display names (one name across libraries for now).
