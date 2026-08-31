# Per-person folders: choose what each person can hear

**Goal** - a library owner narrows one person to chosen folders: the kids hear the kids'
folder, a friend hears the shared drive, and neither is told there is more. Ported from
PearCinema's proven design (its proposal 2026-08-30, PR #225/#230/#231, 28/28 checks on
real hardware), reshaped for music.

**Tier** - T3. It adds a rule to the authorisation surface, and a rule that lets one
track through by mistake is a security bug of the same class as the two inherited ones
in CLAUDE.md.

## Why

A grant today is all or nothing. `grant.paths` has been a reserved null on every grant
since the store was designed, "so library-subset scopes are a value change, not a schema
migration" (host/grants.js) - this fills it. Folders are the shape that is always
answerable (every file has a path) and the shape libraries are actually organised in
(an artist tree, a Kids folder, an audiobooks drive).

## What it looks like

On the dashboard's People page, each person gets one line under their name:

    Can hear: everything

Tapping it opens a tree of the folder source's roots and the folders under them, to any
depth, opening on demand, with ticks. A ticked folder covers everything beneath it.
"Everything" is the default and the state of every existing grant. The owner's own
devices are never filtered and never get the control.

A pairing window carries the same choice, and the panel ASKS - everything or chosen
folders, neither preselected, no code until answered. Both decisions are Tim's from the
PearCinema round (any depth tickable; "Can see: everything is a line somebody has to
notice and disagree with"), adopted here rather than re-asked.

The phone sees a smaller library and nothing else. Favorites, resume points and
playlists referencing hidden tracks are filtered on the way out, never deleted, so a
widening brings them back.

## Where the rule lives

`grant.paths`: null (everything, as today) or a list of `{ root, rel }` prefixes, where
`root` is the folder root's absolute path as configured and `rel` a normalised
forward-slash prefix under it. Every device of a person carries the same value, like
scope. The store stays host-local and never replicated.

The check is one module, `host/visibility.js`, ported nearly verbatim:

    visibleTo(grant, loc) -> boolean        loc = { root, rel } or null
    viewOf(adapter, grant) -> adapter view  (the real adapter when not narrowed)

Module-level functions, not host methods - PearCinema's rule, because detached callers
(the cast token fetch) must be able to ask without holding the host. Three deliberate
rules, easy to get backwards:

- An OWNER is never filtered, whatever the row says.
- An item the adapter cannot place is HIDDEN from a narrowed grant. Failing open would
  make "narrow" mean "narrow, except whatever we could not place".
- An unnarrowed grant gets the real adapter back, so the common case costs nothing.

## Music is derived entities, and that is the one new design piece

PearCinema filters file-shaped items. Music adds albums, artists and genres that only
exist as groupings, so:

- A TRACK is visible when its path falls under a granted prefix.
- An ALBUM, ARTIST or GENRE is visible when AT LEAST ONE of its tracks is, and its
  wire row (songCount, trackIds, albums list) is recomputed from the visible subset -
  a "12 songs" album showing 3 is the honest count.

The folder adapter can answer this for free: it holds the whole catalog in memory, every
track carries its root-relative path, and every album/artist/genre row carries trackIds.
`locationOf` is a map lookup; group visibility is a membership scan over in-memory
arrays, memoized per (grant.paths, scannedAt).

## The chokepoint

Every wire method that hands out content reads the adapter through `viewOf`, built PER
DISPATCH from the connection's LIVE grant snapshot - the same snapshot #402's `setGrant`
refreshes, so a narrowing lands on open connections with no reconnect, exactly like a
reassignment. Methods covered: library.stats/list/get/search, art.get, media.stream,
and the state lists (fav.list, resume.latest/get, count.top, playlist.get) filter hidden
ids on the way out.

Two paths need their own care, found in the adapter survey:

- **art.get and media.stream do not resolve through get()**. The folder adapter's
  stream is a direct map lookup and its art treats coverId as an album id - both get an
  explicit visibility check in the view, so a hidden track is not one guessed id away.
- **The speaker path is not a HyperDHT connection.** The cast token fetch
  (host/cast.js) already re-reads the grant live per fetch; it asks `visibleTo` there
  too, and voice resolution resolves through the view. As with revoke: a cast already
  playing is not stopped by a narrowing - narrowing is not revoke.

## Sources that cannot enforce it fail CLOSED

The Subsonic adapter is a pure proxy: it discards the upstream path field, its cursors
are upstream offsets and its art passes raw upstream ids through. It cannot enforce a
prefix. So in v1:

- Narrowing is only OFFERED (dashboard and pairing) while the active source is the
  folder adapter, and `setPersonPaths` refuses otherwise, saying why.
- If a narrowing EXISTS and the operator then swaps to a source that cannot enforce it,
  the narrowed person is served an EMPTY library and the dashboard says so on the
  People page. Hidden-except-what-we-cannot-place is not on the table.

Jellyfin reports a real per-item path, so it is the designed-in follow-up: the same
`{ root, rel }` shape with Jellyfin's libraries as roots, behind the same seam. Not v1.

## The phone

Nothing on the wire changes shape - a filtered list is a list. Two touches ride #402's
plumbing:

- `setPersonPaths` refreshes live handles and pushes `grant:changed` to each device.
- On `grant:changed` the worklet also rebuilds the merged index, not just tells the UI -
  PearCinema's follow-on lesson: without the rebuild "the films could not be opened,
  but the list lied".

Downloads already on the phone keep playing (the person was allowed the track when they
took it); the People page says so in one line when a narrowing is saved. Same v1 answer
as PearCinema, same recorded reason: the host cannot reach an offline phone, and a rule
enforced "sometimes" reads as a bug.

## Dashboard plumbing

- `GET/POST /api/sharing/folders` - the folder tree, one level per call to any depth
  (a big library cannot ship as one payload). Backed by two new folder-adapter methods,
  `rootsForSharing()` and `foldersUnder({ root, rel })`.
- `POST /api/sharing/set { personId, paths }` - through the host (`setPersonPaths`),
  which writes every live grant of the person, refreshes handles and pushes.
- `startPairing({ paths })` stamps the choice on the grant at pair time, so a person
  let in narrowly never has a wide window.

## Compat and rollback

- `paths` is already on every row as null. Old hosts ignore it; old phones never see
  it; the wire is unchanged.
- Rollback: set paths back to null (the People page's "everything") or revert the host;
  the check returns true and the host is exactly today's. No migration either way.

## Verify

Unit: the visibleTo/under/normalRel truth tables; group visibility (album with one
visible track shows, with zero hides, counts recomputed); unplaceable item hidden;
owner never filtered; view stats match filtered lists; setPersonPaths refuses on a
non-folder source. Integration over the DHT testnet: two paired devices, one narrowed -
list/get/search/stats/art/stream all refuse hidden items for the narrowed one and not
the other; narrowing lands mid-connection without reconnect; widening restores; revoke
still cuts a narrowed device within a second. Hardware: TCL against a real multi-folder
library - narrowed browse, hidden track unplayable, favorites of hidden tracks absent
and back after widening.

## Open questions

1. The wire currently sends each track's root-relative `path` to clients. Narrowed
   clients only ever receive visible tracks, so nothing hidden leaks - but the paths
   themselves reveal folder names the person was granted. Fine for v1?
2. Genres: a narrowed person's genre list shrinks to genres with visible tracks. A
   genre NAMED like a hidden folder ("Audiobooks") can still vanish confusingly. Accept
   for v1.
