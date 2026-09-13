# Audiobookshelf as a books source beside the music

**Goal** - a host that already serves music from a folder, Subsonic or Jellyfin can also
serve the books in an Audiobookshelf server, blended into the same library. The phone sees
them in Books exactly like books from a marked folder: chapters, speed, resume and bookmarks
all work. Asked for by the user behind proposal 2026-09-13, who runs Audiobookshelf on a
Raspberry Pi 5 behind a Cloudflare Tunnel.

**Decided (Tim, 2026-09-14)** - a books ADD-ON beside the music source, not a fourth
source that replaces music. The host combines two sources.

**Tier** - T2. New persisted config (an Audiobookshelf URL and a secret), a new adapter,
and a host that answers from two adapters at once. No wire change: the phone already
understands `kind: 'book'`, `chapters`, `caps.books` and every method it will call. One
access rule needs care (per-person folders, below).

## What Audiobookshelf offers

Checked on the Umbrel's Audiobookshelf 2.36.0 (8 books, including The Hobbit in 219 files):

| Need | Audiobookshelf API |
| --- | --- |
| Log in | API key (Settings > API Keys, long-lived, `/api/api-keys` answers) or `/login` for short-lived access + refresh tokens |
| Book libraries | `GET /api/libraries` (`mediaType: book`; podcast libraries are skipped) |
| Books | `GET /api/libraries/:id/items` (paged; title, author, genres, duration, file count) |
| One book | `GET /api/items/:id?expanded=1`: `media.tracks` (one per audio file, with `startOffset`, `duration`, `mimeType`, `ino`) and `media.chapters` (book-wide `start`/`end` in seconds) |
| Audio | `GET /api/items/:id/file/:ino`, byte ranges (206, `accept-ranges: bytes`) |
| Cover | `GET /api/items/:id/cover?width=N` |

Reachable from the PearTune container on the Umbrel at `http://localhost:13378` (the app
runs with host networking, like the Navidrome URL it already uses).

## The shape

### Mapping

| Audiobookshelf | PearTune | Notes |
| --- | --- | --- |
| book (library item) | album, `kind: 'book'` | name = title, artist = author, year = publishedYear |
| audio file (track) | track, `kind: 'book'` | title from its tag or file name, `durationMs` from the file |
| book chapters | `chapters` on each track | only the chapters inside that file's `[startOffset, startOffset + duration)`, shifted to the file's own time. Dropped when they only repeat the file boundaries (Audiobookshelf makes one chapter per file for a book in parts) |
| author | artist, `kind: 'book'` | |
| genre | genre, `kind: 'book'` | |

Ids go through `protocol/ids` with the adapter kind `audiobookshelf`, keyed on the book id
and the file `ino`, so they cannot collide with music ids and survive a rescan.

### Two adapters, one library

`host/adapters/combined.js` wraps the music adapter and the Audiobookshelf adapter and
presents the adapter interface the host already calls (`list`, `get`, `search`, `stats`,
`art`, `stream`, `scan`, `probe`). It keeps an id-to-adapter map built at scan, so `get`,
`art` and `stream` go to whichever source owns the id.

- `list` with `kind: 'music'` asks only the music adapter, so music pages and cursors are
  exactly what they are today.
- `list` with `kind: 'book'` merges the music source's own books (a marked folder) with the
  Audiobookshelf books, sorted, then pages the result.
- No `kind` (an older phone) returns the music adapter's page and then the books.
- `search` asks both and concatenates.
- `stats` adds up counts; `books` includes both. `caps.books` is set when either has books.

When no books source is configured, the host uses the music adapter directly, as today.

### Config and dashboard

`source.json` keeps `active` + `sources` and gains `books: { kind: 'audiobookshelf', url,
apiKey | username + password }`, or no `books` key at all. Secrets follow the existing
rules: never sent to the browser, kept when the form sends them back empty.

The Music Source panel gets an **Audiobooks** section under the music source: "Also serve
books from Audiobookshelf", URL, API key (or username and password), Test, Save, Remove.
Detection offers `http://localhost:13378` when an Audiobookshelf answers there.

The dashboard's scan summary already counts audiobooks, so it covers these too.

### Listening state stays on PearTune

Resume positions, bookmarks and "Continue listening" stay in the host's per-person store,
keyed by the PearTune track id, exactly like folder books. Audiobookshelf's own progress is
not read or written: the host talks to it with ONE credential, so every PearTune person
would collapse into one Audiobookshelf user. Importing a person's progress from their own
Audiobookshelf account is a possible later step, out of scope here.

### Per-person folders: fail closed

Narrowing a person to chosen folders works only on the folder source today. Audiobookshelf
books have no folder in PearTune's tree, so a NARROWED person sees no Audiobookshelf books
at all in this proposal. An unnarrowed person sees all of them. Showing Audiobookshelf books
to a narrowed person (per library, or per book) is a later decision. The combined adapter's
`narrowedView` must return the music view alone, and a test must hold that.

### Transcoding

Direct play streams the file's bytes through the host with Range, like Jellyfin. "Auto"
quality on cellular transcodes on the host. A book's index is often at the END of an m4b,
which ffmpeg cannot reach through a pipe, so the transcode reads the Audiobookshelf URL
directly (`-headers 'Authorization: Bearer ...' -ss <t> -i <url>`), which lets ffmpeg seek.
`host/transcode.js` gains an input-headers option for that.

## Build order

1. **The Audiobookshelf adapter on its own.** Scan, list, get with chapters, search, art,
   stream (direct), probe; API key and username/password. Tests against a fake
   Audiobookshelf HTTP server built from the real 2.36.0 responses above.
2. **Combined adapter, config and dashboard.** Routing by id, kind-aware listing and paging,
   the fail-closed narrowing, source.json `books`, the Audiobooks section with Test and
   detection. Tested against the fake server plus the folder fixtures.
3. **Transcoding and the Umbrel.** Seekable HTTP-input transcode; deploy to the Umbrel with
   its Audiobookshelf as the books source and check on the Pixel and the emulator.

## Compatibility

| Host | Phone | Result |
| --- | --- | --- |
| New, books source set | Old (before Books) | Audiobookshelf books appear as albums after the music, and play |
| New | New | Books view includes them |
| Old | any | No change |

## Risks

- **Large books, many files.** The Hobbit is 219 files. A full scan fetches every book's
  detail once (one request per book), which is fine at hundreds of books and slow at many
  thousands. If that bites, fetch details lazily on first `get` and keep only the list
  fields from the paged items call.
- **Audiobookshelf down while music is fine.** A books-source failure must not take music
  with it: the combined scan keeps the music adapter serving and reports the books error in
  the dashboard, like `sourceError` does today.
- **Token expiry.** Username/password logins return short-lived tokens (the saved one had
  expired within a day). The adapter refreshes on 401, and the dashboard recommends an API
  key.
- **Two sources, one "Recently added".** Book albums are kept out of the music shelf by
  `kind: 'music'` already.

## Verify

- `npm run verify` green per slice.
- Emulator first, against a local host combining the folder fixtures with a fake or real
  Audiobookshelf; then the Umbrel's real Audiobookshelf (The Hobbit, 219 files) on the Pixel.
- Fail-closed check: a narrowed person sees no Audiobookshelf books, over the wire.

## Rollback

Remove the `books` key (the dashboard's Remove does this); the host goes back to the music
adapter alone. Resume rows and bookmarks for Audiobookshelf track ids stay in the store,
unused, and come back if the source is added again.

## Open questions

1. Several Audiobookshelf book libraries on one server: serve all of them, or pick which?
2. Should a narrowed person be able to see Audiobookshelf books later, and if so chosen how?
