# Multi-host: the merged library (step 2 of 2)

**Goal** — connect to *all* paired hosts at once and present **one blended,
deduplicated library** across them. Browse artists/albums/songs/genres as if the
Umbrel's 2400 tracks and the Mac mini's 200 were a single collection; search hits
everything; tapping play streams from whichever host actually holds the file. This
is the "gateway to multi-source" payoff step 1 was built to enable.

**Tier** — **T3.** It replaces the client's core single-active-connection model
with N concurrent host connections, adds per-track host routing to streaming, and
introduces a lossy dedup. It does **not** touch the wire protocol, the grant store
(still host-local, per-host), or the revoke guarantee — each host keeps
authorizing this device independently and a revoke still kills *that host's*
connection (and thus its tracks). The blast radius is playback correctness across
many connections, which is why it gets a proposal and phases.

Decisions confirmed with Tim (2026-07-19):
- **Full fuzzy dedup** — the same song on two hosts shows once; one clean library.
- **Merged is the default view** — the home screen is the blend; a source-filter
  chip narrows to one host. (Supersedes step 1's "switcher-only"; the per-host
  switch becomes a filter.)
- **Phase 1 is read-only: browse + search + play.** Merged favorites, resume,
  counts, and cross-host "Play here" are later phases.

---

## What step 1 gives us (the foundation)

- **A host list** (`worklet/hosts.js`) and **per-host state dirs** (`lib/<libraryId>/`).
- **Shared, content-addressed audio/art caches** — track/art ids are already
  `hash(libraryId + …)`, so nothing collides and a cached blob is served
  host-agnostically. The cache-hit path needs no connection at all.
- **One warm shared HyperDHT node** — N concurrent client connections come off it
  with no extra bootstrap cost (this is what makes "connect to all hosts" cheap).
- **IDs are namespaced by `libraryId`** — so a track from the Umbrel and one from
  the Mac never collide, which is the precondition for a mixed-host queue.

## The two hard problems (and the idea that dissolves the first)

The architecture map flagged two genuinely hard parts. The first has a clean way out:

**1. A globally-sorted, paginated merge across hosts is not expressible on the
wire** — each host paginates with its own opaque cursor, and Subsonic can't even
sort songs. You cannot k-way-merge two hosts by title when neither sorts by title.

**The way out: an in-memory merged index.** PearTune targets *personal* libraries
(thousands, not millions, of tracks). So on entering the merged view we fetch each
connected host's **full catalog** once (loop the existing pagination to exhaustion),
build one merged + deduped index in the worklet, and serve every browse/search/sort
request from memory. This turns the unsolvable "paginated cross-host merge-sort"
into ordinary in-memory sorting — and as a bonus lets us sort by **any** field
(title/artist/album/year/duration) regardless of a host's own sort capability. Cost:
a few seconds' fetch on first load and a few MB of RAM. Worth it.

**2. `trackId` is a one-way hash — you cannot recover a track's host from its id.**
So a mixed-host queue, per-track streaming, and per-track favorite-writes all need
the owning `libraryId` **carried alongside** every track. This is the prerequisite
that threads through the whole phase. It's mechanical but wide.

## Design (phase 1)

### 1. Connect to all hosts — `client` becomes a map

`client`/`currentHost`/`connected`/`reconnecting` (all singletons in `src/bare.js`)
become `hostConns: Map<libraryId, { client, connected, reconnecting }>`.
`ensureConnected()` splits:

- `ensureConnected(libraryId)` — reconnect one host (the step-1 single-flight, per
  entry), used by streaming a specific track and by per-host writes.
- `ensureAll()` — connect every paired host in parallel; used before an index build.
  An **offline host is not an error** — it's simply absent from the merge, its tracks
  greyed and unplayable until it's back (each host reconnects independently, exactly
  like today's on-demand reconnect, just N of them). All come off the one shared DHT.

### 2. The merged index

A worklet-side structure built by `ensureAll()` then a full-catalog fetch per host:

```
mergedIndex = {
  artists: [{ key, name, coverRef, albumCount }],
  albums:  [{ key, name, artist, year, coverRef, songCount }],
  tracks:  [{ key, title, artist, album, track, year, durationMs,
             copies: [{ libraryId, trackId, coverId, suffix, size }] }],
  genres:  [...]
}
```

Each entity has a **merge `key`** (the dedup key, §3) and — for tracks — a `copies`
list of every host that has it. Browse/search/sort all read this. It's rebuilt on
launch, on entering merged mode, and on a host reconnect or rescan (a host coming
online adds its catalog; going offline drops it). Persisted to `lib/_merged/` as a
cache so a cold launch can render instantly and refresh in the background.

Pagination is now trivial: slice the sorted in-memory array. Sort is any field.

### 3. Full fuzzy dedup + primary/alt selection

The lossy part, made explicit. Normalized keys (mirroring how the folder adapter
already groups albums and genres normalize case):

- **track key** = `norm(artist) | norm(album) | track# | round(durationMs, 2s)`
- **album key** = `norm(albumartist ?? artist) | norm(album) | year`
- **artist key** = `norm(name)`

where `norm` lowercases, trims, strips punctuation/feat./the-. Two hosts' entries
with the same key merge into one. Each merged track keeps **all** its `copies`; one
is the **primary** (the first-added host, or the higher-bitrate/lossless one — a
tie-break we can tune). Streaming resolves to the **best *connected*** copy at play
time (§5), so a merged song survives its primary host going offline as long as
another copy is online — the dedup is robust, not brittle.

**Accepted lossiness (Tim's call):** a real re-rip with different tags or a
rounding-boundary duration can slip through as two entries; a false key-collision
can hide a copy. Duration+tags is the realistic key (byte-size and format differ
across copies, so they can't anchor it). We surface *nothing* silently wrong — a
merged entry with multiple copies can show a small "on 2 servers" affordance in the
detail view so the dedup is inspectable.

### 4. Per-track `libraryId`, threaded everywhere

Every track/album/artist object returned to the UI gains the owning host tag (for a
merged track, its `copies`; for a single-host filtered view, one `libraryId`). This
threads from the adapter response → the worklet's `withArt` → the UI's row/queue
items → `saveQueueState` (each queue item stores its `copies`/`libraryId`) → back
into `urlFor`. This is the wide, mechanical prerequisite; nothing routes correctly
without it.

### 5. Streaming routing — the shim picks the right host

The loopback URL scheme gains the library: `/t/<libraryId>/<trackId>` and
`/art/<libraryId>/<coverId>` (from `worklet/shim.js`). `urlFor(trackKey)` looks the
track up in the merged index, picks the **best connected copy**, and mints its
`libraryId`-scoped URL. The shim parses the `libraryId`, serves a **cache hit
host-agnostically** (ids are already namespaced, so downloaded/cached audio just
plays — including offline), and on a miss routes `streamTo`/`art` to
`hostConns.get(libraryId).client`, calling `ensureConnected(libraryId)` first.

Cold-launch resume works because the URL carries the `libraryId` (no reliance on an
in-memory map that a never-browsed track would miss), and the merged index is
rebuilt on launch anyway.

### 6. Mixed-host queue

Playing from the merged view builds a queue whose items span hosts. Each item
carries its `libraryId`/`copies` (§4), so `urlFor` routes each correctly and the
queue persists faithfully. The merged queue lives at `lib/_merged/queue.json` (there
is no single "active library" in merged mode, so the `activeLibraryId`/`libDir()`
singleton gains a `_merged` context for merged-level state). A **revoke on one host
starves/skips only that host's tracks** (its connection dies; the existing
decideStarve + graceful-skip handles it), while the other hosts' tracks keep
playing — the per-host revoke guarantee, now in a mixed queue.

### 7. UI — merged by default, source as a filter

The library home renders the merged index. A filter row — `[All] [Umbrel] [Mac]` —
narrows to one host (which is just the merged index filtered by `libraryId`, so the
per-host view is free and step 1's per-host experience is preserved as a filter). A
merged album/track detail can show which server(s) hold it. The Settings › Libraries
list stays for add/remove/pair; "which library is active" becomes "which filter,"
and "All" is the default.

## Phasing

- **Phase 1 (this proposal): read-only merged browse + search + play.** The merged
  index, N concurrent connections, per-track `libraryId` threading, streaming
  routing, the mixed-host queue, and the merged-default UI. Favorites/resume/counts
  route to a track's owning host where trivial, but the **aggregate** "You" views
  stay per-filter for now.
- **Phase 2: merged user-state.** Union favorites/resume/counts across hosts; a
  heart-tap routes to the owning host; per-host outbox fan-out. Mostly mechanical
  *once §4's host tags exist*.
- **Phase 3: cross-host session + "Play here".** The hard one: one person, N
  independent host session tokens, a merged queue no single host can store. Needs a
  session-authority design (elect one host, or a client-authoritative session). Its
  own proposal.

## Security review

- **Grant store stays host-local, per host.** Untouched — no host code changes.
- **Revoke is unchanged and still per-host and instant.** Revoking this device on
  the Umbrel kills its Umbrel connection (and starves/skips Umbrel tracks in the
  mixed queue) within a second; the Mac connection and its tracks are unaffected —
  correct, two independent authorities. The acceptance test becomes per-host: revoke
  on A cuts off all NEW access to A immediately; B keeps working.
- **N connections, one identity.** Same device key presented to N hosts — already
  true in step 1; connecting to several at once is not new exposure. All are Tim's.
- **No bearer tokens.** Still pure per-host Noise auth. ✓
- **Offline host = absent, not failed-open.** A host we can't reach contributes
  nothing to the merge; its tracks are greyed. No content is ever served from the
  wrong host (the cache is content-addressed; the live path routes by `libraryId`).

## Verify

- **Unit:** the dedup keying (pure `norm` + key builders, table-driven — same/diff
  hosts, re-rip near-miss, punctuation/feat. variants); merged-index build + sort +
  filter (pure, over fixture catalogs from 2+ hosts); best-connected-copy selection
  (primary online/offline).
- **Hardware (TCL + Umbrel + Mac mini):** enter the merged view → one blended,
  sorted, deduped library (an album on both hosts appears once); search hits both;
  play a track from each host back-to-back in one queue; filter to one host and back;
  take a host offline → its tracks grey, the other keeps playing; **revoke on one
  host mid-song → only its tracks stop, the other host's keep playing**; a downloaded
  track still plays with everything offline.
- **Gate:** `npm run verify` green.

## Out of scope / open questions

- **Phases 2–3** (merged favorites; cross-host session/"Play here").
- **Streaming fallback tuning** — which copy is "primary" (first-added vs
  quality-ranked) and whether to auto-fail-over mid-track if a host drops.
- **Huge libraries** — the in-memory index assumes personal scale; a 100k-track
  library would want a different strategy (out of scope; not PearTune's target).
- **Merged sort menu** — with the full index in memory we *can* sort by any field;
  confirm the UI still intersects to a sensible default set.
- **Rescan/refresh coordination** — when one host rescans, rebuild just its slice of
  the index rather than the whole thing (optimization, not phase-1-blocking).
