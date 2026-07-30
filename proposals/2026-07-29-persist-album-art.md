# Persist album art once per library, not once per session

## Goal

Stop re-fetching cover art from the host on every cold start: store each cover on disk
the first time it is seen, at the size it was requested, and keep it until its library is
removed.

## Tier

T2. New persisted state (art keyed by size, plus a blob-to-library index) and a change to
what library removal deletes. No wire change, no host change, phone-side only.

## Context: what happens today

Two layers, and only one of them survives the app closing.

- **In memory**: `artCache` in `worklet/shim.js`, a `Map` capped at `ART_CACHE_MAX = 120`,
  keyed `coverId + ':' + size`. Makes scrolling a grid cheap. Gone on restart.
- **On disk**: `ArtStore` at `DATA_DIR/art` (`worklet/art-cache.js`), keyed by `coverId`
  ALONE, with no size.

The only writer to disk is the **pin/download** path (`src/bare.js:3625`, inside album
pinning). **Browsing never persists a cover.**

And because the disk key has no size, the shim can only read from disk at one size:

```js
if (artStore && (localOnly || (size === DEFAULT_ART_SIZE && leaseOk()))) {
```

`DEFAULT_ART_SIZE` is 300. The library grid requests 120, 350 or 500 depending on density.
So **grid art never comes from disk at all**, even for an album that has been downloaded.

Net effect: every cold start re-fetches every visible cover over the P2P connection. When
that connection is relayed, it is bandwidth PeerLoom pays for, spent repeatedly on bytes
that do not change. Measured context: three cellular runs on 2026-07-29 had the relay
carrying the connection in most of them, and art is explicitly NOT gated by the new
relay-audio consent (proposal 2026-07-29-relay-audio-consent, decision 1), so it crosses
the relay whether or not the user allowed music to.

## The load-bearing constraint, already documented in the code

`src/bare.js` on the shared blob caches:

> Ids are hashed per library and cannot be attributed back to one, so a precise
> per-library purge needs the cache index to record the library - logged as a follow-up

So today, removing ONE library purges none of its blobs. Only removing the **last** library
clears anything (`audioCache.clear()` + `artStore.clear()`). "Keep it until they delete
that library" therefore cannot be built on the current store - it needs that index. This
proposal builds it, which also closes the pre-existing gap for the AUDIO cache.

The shared-at-the-root design must survive it, and for good reasons stated where it is
defined: ids are already namespaced per library so nothing collides, bytes de-dupe across
libraries, and a track that is mid-play keeps streaming when you switch libraries. So the
fix is an INDEX recording ownership, not a move to per-library directories.

## Scope

Changes:

- `worklet/art-cache.js` - key entries by `coverId` + `size`, mirroring the in-memory key.
  `has/get/put` take a size. The filename becomes `encodeURIComponent(coverId) + '@' + size`.
- `worklet/shim.js` - drop the `size === DEFAULT_ART_SIZE` restriction on the disk read, since
  each size now has its own entry, and WRITE to the store after a successful live fetch
  (the browse path, not only pinning).
- A blob index at `DATA_DIR/blob-owners.json`: `blobKey -> libraryId`, written when art or
  audio is stored. Small, and it is the thing that makes per-library purge possible.
- `removeHost` - purge the blobs the index attributes to that library, for BOTH art and
  audio. The last-library `clear()` stays as the belt-and-braces path.
- A cap on browse-populated art, since it is now unbounded where pinning was bounded by the
  pinned albums. Count-based LRU (see open question 2).

Does NOT change:

- The wire protocol, the host, grants, revoke.
- `AUDIO_DIR`/`ART_DIR` staying SHARED at the root, or the de-dupe and
  keeps-playing-across-a-switch properties that depend on it.
- The lease gate on serving cached art. A revoked or long-offline device still goes dark.
- Whether art crosses the relay without consent. That is decision 1 of the consent
  proposal and is unchanged here; this change makes it happen far less often, which is a
  side benefit and not a reason to revisit the consent boundary.

## Compat

Phone-side, additive, no migration required.

- Existing `DATA_DIR/art` files are keyed without a size. They are simply never hit by the
  new size-keyed lookups, so they become dead bytes. Delete them on first run of the new
  code (a one-line sweep of size-less filenames) rather than leaving orphans forever.
- `blob-owners.json` absent means "nothing attributed yet": removal falls back to today's
  behaviour (purge nothing per library, clear everything when the last library goes), so an
  upgrade is never worse than the status quo.
- Downgrade: an older build ignores the index and reads the old flat key, finding nothing,
  so it re-fetches. Lossy, never broken.

## Verify

Unit:

- `art-cache` round-trips per size: `put(id, 300, a)` and `put(id, 500, b)` are distinct
  entries and `get(id, 500)` returns `b`. This is the bug being fixed, so it gets a test.
- The index attributes a blob to a library, and purging library A leaves library B's blobs
  intact - including the case where BOTH libraries have a cover with the same id, which is
  what the de-dupe makes possible.
- A size-less legacy filename is swept on first run.
- Cap eviction removes the least recently used and never a pinned album's cover.

On device (TCL, wifi is fine - this needs no relay):

1. Cold start, browse a library, note the covers load. Force-stop and cold start again:
   the grid must populate with NO `shim:art-*` fetches in the log, which is the whole point.
2. `run-as` the app and confirm `DATA_DIR/art` holds size-suffixed files after browsing
   ALONE, with nothing pinned.
3. Pair a second library, browse it, remove the FIRST one, and confirm only the first
   library's blobs went.
4. Remove the last library and confirm everything is cleared, as today.

A byte-level check is available if wanted: browse over a relayed cellular connection, then
cold start again and confirm the relay's counter moves on the first pass and not the second.
That is the actual saving, stated in bytes.

## Rollback

Revert. The index and the size-keyed files are additive and an older build ignores both;
the only irreversible act is the legacy sweep, which deletes art that build could not read
anyway and which re-fetches on demand.

## Open questions

1. **Should the store be invalidated when a server changes an album's art?** Tim's framing
   is "keep it unless they delete the library", which is simple and predictable. The risk is
   a stale cover that never updates. Most sources change the coverId when the art changes,
   which self-invalidates - but not all do. Options: accept it, add a manual "refresh
   artwork" action, or re-fetch on some interval. I lean accept-it plus a manual refresh, on
   the grounds that a wrong cover is annoying and a repeated download is expensive.
2. **What cap, and by count or by bytes?** The audio cache uses a byte cap the user controls
   (`cacheCap`). Art is small individually and unbounded in count: a 1358-track library is
   perhaps 150 albums, so tens of MB - but a large shared library could be thousands. I lean
   a generous count cap (a few thousand entries) that never evicts a pinned album's cover,
   and NOT a user-facing setting, because nobody wants to tune an artwork budget.
3. **Should the audio cache's per-library purge land in the same change?** The index makes it
   possible and the code comment already asks for it. Doing both is barely more work than
   doing art alone; doing art only leaves the documented gap open with the mechanism sitting
   right there unused.
