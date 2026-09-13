# Audiobooks: the basics

**Goal** - someone with a folder of audiobooks (m4b, or m4a/mp3 split into parts) can
open PearTune, find their books apart from their music, skip back and forward, keep a
bookmark and pick up where they stopped. Each person on a library keeps their own place.
Asked for by a user on 2026-09-13 who runs Audiobookshelf behind a Cloudflare Tunnel on a
Raspberry Pi 5 and wants "something extremely simple" that reaches a folder.

**Tier** - T2. It adds persisted host state (bookmarks), new media RPC methods, a new
optional field on tracks and albums, a new host capability flag and a new folder-source
setting. No auth gate moves: bookmarks are keyed by `ownerId` exactly like resume
positions, and per-person folder grants already decide which books a person can see.

**Out of scope, phase 2** - a host that runs on a Raspberry Pi 1 (32-bit ARMv6, 512 MB;
the image is amd64/arm64 only and the native crypto and UDP addons have no armv6 builds),
an Audiobookshelf source adapter, Jellyfin's `AudioBook` item type, downloading a whole
book for offline listening and podcasts.

## What already works

| Need | Today |
| --- | --- |
| Remote access with no tunnel | The whole app |
| Per-person progress | `resume:{ownerId}:{trackId}` on the host (host/state.js:126), applied on tap (App.jsx:2301) |
| Family members as separate people | Per-person grants; per-person folders narrow each one |
| Skip back / forward | ±15 s buttons on the player (App.jsx:5825), lock-screen seek |
| Cover art | Folder image, then embedded picture (host/adapters/folder.js:829) |
| m4a playback | Scanned and passed through untranscoded on wifi |
| Sleep timer | 15/30/45/60 min and end of track |

## What is wrong for books

1. **m4b files are invisible.** `AUDIO_EXT` has no `.m4b` (folder.js:40), and the phone
   shim's `mimeFor` has no m4b entry, so one would be served as
   `application/octet-stream` (worklet/shim.js:111).
2. **Books are mixed into music.** They land in Albums, Songs, Genres, Recently added and
   Shuffle all.
3. **The resume rules are tuned for songs.** A position past 95% is cleared
   (App.jsx:936). On a 10-hour book that throws away the last 30 minutes.
4. **Books count as plays.** A play is counted at min(50%, 4 min) (App.jsx:947), so a
   book shows up in Most played after 4 minutes.
5. **No chapters.** An m4b stores them inside one file and nothing reads them.
6. **No bookmarks** beyond the one automatic resume position.
7. **No playback speed.** Nothing calls `setPlaybackRate`, though expo-audio has it.
8. **Lock-screen seek is probably 10 s.** `SEEK_STEP = 15` (app/index.tsx:317) is the
   in-app step, but expo-audio's ExoPlayer uses `SEEK_JUMP_INTERVAL_MS = 10_000`. Check on
   a device; fix regardless of this proposal.

## The shape

### What counts as a book

A track is a book when either:

- its file is `.m4b` (any source that reports `suffix`), or
- it sits under a folder root the owner marked **Audiobooks** in the dashboard.

Folder-source config keeps `roots: string[]` and gains `bookRoots: string[]`, a subset of
`roots`. An older host ignores the new key and shows those books as music, which is
today's behaviour. Genre-tag detection ("Audiobook", "Spoken Word") is left out: tags are
unreliable and a wrong guess hides music.

An album whose tracks are all books is a book. A book made of 40 mp3 parts is one album
with 40 tracks, grouped by the existing album rules (folder.js:354).

### Wire changes (all optional, all additive)

- `ping` caps gain `books: 1` (host/media.js:242). The phone shows book features only for
  a library that sets it, through the existing `capsFor` fallback (src/bare.js:64).
- Tracks and albums gain `kind: 'book'`. Absent means music. Old phones ignore it.
- Book tracks from an m4b gain `chapters: [{ title, startMs }]`, read at scan time with
  music-metadata's `includeChapters` (supported for MP4 in the installed 11.14.0). Only
  on the album and track detail responses, so list responses do not grow.
- New methods `bookmarks.list(trackIds)`, `bookmarks.add({ trackId, positionMs, note })`
  and `bookmarks.remove(id)`. An old host answers `ENOMETHOD` and the bookmark button
  hides.

### Host state

`bookmark:{ownerId}:{trackId}:{id}` -> `{ id, trackId, positionMs, note, createdAt,
deviceKey }`. Same store, same per-person keying and same owner-only visibility as resume.
`bookmarks.add` and `bookmarks.remove` go through the offline outbox (worklet/outbox.js)
keyed by bookmark id, so a bookmark made in a car with no signal lands later.

### Where books live in the app

The Genres / Artists / Albums / Songs control is already full, so books do **not** get a
fifth segment there. Books are removed from all four views, from Recently added and from
Shuffle all.

Recommended: a **Books** tab in the bottom bar, shown only when a connected library has
`caps.books` and at least one book. A music-only user sees no change. See open question 1
for keeping the bar at five tabs.

The Books tab is a cover grid with a **Continue listening** row on top (every book with a
resume row for this person, most recent first). Tapping a book resumes it: for an m4b
that is the saved position; for a book in parts it is the part with the newest resume
row. Tapping a part inside a book's page plays that part from its own saved position.

### The player when a book is playing

Same player, with these changes while the current track is a book:

- Shuffle and repeat are replaced by **speed** (0.8x to 2x, pitch corrected, remembered
  per person per book in local settings) and **chapters** (a list; tap to jump).
- Previous / next move by chapter when the file has chapters, by part otherwise.
- The secondary row keeps its four buttons and gains a **bookmark**
  button that saves the current position with an optional note.
- The sleep timer gains **End of chapter**.
- Resume is cleared only when the book reaches its last 30 seconds, not at 95%.
- No play counts.

## Build order

Each slice is its own PR, verified before the next starts.

1. **Host: books exist.** m4b in `AUDIO_EXT`, m4b in the shim's `mimeFor`, `bookRoots` in
   the folder config and dashboard folder panel, `kind: 'book'`, `caps.books`. Books still
   show in Albums on phones at this point. Tests: a tiny committed m4b fixture scans as a
   book with its cover; a `bookRoots` folder marks its tracks; an old-shape config loads.
2. **Phone: books are separate.** The Books tab, the Continue listening row, removal from
   the music views, the book resume rules and no play counts.
3. **Player book mode.** Chapters (host parse plus the list and prev/next), speed and End
   of chapter.
4. **Bookmarks.** Host state, the three methods, outbox, the bookmark button and a
   bookmark list on the book page.

The user who asked can listen after slices 1 and 2.

## Compatibility

| Host | Phone | Result |
| --- | --- | --- |
| New | Old | Books appear as albums, m4b now included. An old phone serves m4b as `application/octet-stream`: ExoPlayer sniffs the container, iOS may not. Check both in slice 1. |
| Old | New | No `caps.books`: no Books tab, no bookmark button, today's app. |
| New | New | Full feature |

In a merged view of several libraries, books from any library with `caps.books` go to
the Books tab; the rest stay in music.

## Risks

- **Cache size.** A 10-hour book at 64 kb/s is about 290 MB. The LRU audio cache would
  save a whole-file range (shim.js:315) and push out music. Slice 2 skips the automatic
  cache for book tracks larger than a set size; pinned downloads are phase 2.
- **Cellular transcode seek.** "Auto" quality transcodes to mp3 on cellular, and seeking
  inside a transcode needs `caps.timeOffset`. A seek deep into a long book re-starts
  ffmpeg with `-ss`, which should be fine but is untested at 8+ hours in.
- **Chapter parse cost.** `includeChapters` runs only for m4b files, so music scans are
  unaffected. Measure a rescan of a large book folder on the Umbrel in slice 3.
- **Gapless queue and speed.** Speed is set on the one ExoPlayer instance, which also
  holds the music queue. Switching from a book back to music must reset it to 1x.

## Verify

- `npm run verify` green on every slice.
- Emulator first for the Books tab, player book mode and bookmarks (rule 15).
- TCL for lock-screen seek step, background playback of a long book with the screen off
  and speed on the lock screen.
- Per-person check: two people on one host, each listening to the same book, each
  resumes at their own place.

## Rollback

Revert the slice. Bookmark rows left on a host are unused keys and harmless. `bookRoots`
left in a config is ignored by the older host.

## Open questions

1. Six tabs, or keep five by moving About into Settings?
2. Skip sizes for books: keep ±15, or back 15 / forward 30 as most book apps do?
3. Should the dashboard's Audiobooks mark be per folder root only, or also on any subfolder?
