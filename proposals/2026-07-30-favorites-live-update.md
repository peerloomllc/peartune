# A favorite made on one device appears on the others without reopening the app

**Goal** - the host tells a person's OTHER live devices when their favorites change, so the
hearts and the Favorites list update while the app is open instead of on the next relaunch.

**Tier** - T2. A new push kind on the media channel (an IPC message shape).

## Why

Reported by Tim 2026-07-30, twice: favoriting an artist on the Pixel did not appear in the TCL's
Favorites list, and the same for a track. "If I dismiss the app and reopen it, everything gets
updated and looks to be in sync." An earlier report the same day was the same bug seen from the
other side: the Favorites LIST had the item but the heart on the album/artist/song was not filled.

The cause is that **no push exists for user state.** The host pushes `library-renamed`,
`devices:changed`, `request:new`, `request:resolved` and `session-superseded` - and nothing at all
for favorites, so a device that is already connected is never told. `favorites()` in the worklet
always reads live from the host (its on-disk copy is only an offline fallback), so the staleness is
entirely in WHEN the app asks: on mount, on `host:connected`, on a merged host joining, on a host
switch, and on the local toggle. A phone sitting connected asks at none of those moments, which is
exactly why a relaunch fixes it.

That also explains the list-and-heart disagreement in the earlier report. The Favorites list
refetches its resolved rows when the screen is opened (`setFavItems(null)`), but the id sets that
fill the hearts do not - so opening the list showed the new favorite while the album page it came
from still showed an empty heart. One root cause, two symptoms.

## Scope

- `presence.notifyOwner` gains an `exceptDevice` option, so a push reaches a person's OTHER
  devices and not the one that just made the change (which already knows, and re-rendering it from
  a push would fight its own optimistic update).
- `fav.set` pushes `favorites:changed` with `{ kind, id, on, libraryId }` after a successful
  write. The payload is enough for a client to be specific later; today the client just refreshes.
- The worklet forwards it to the UI as an event. It does NOT refresh its own copy - `favorites()`
  is already a live read, so a second fetch would be wasted.
- The UI reloads the id sets and drops the resolved list so it refetches when next opened.

**Not in scope.** Playlists have the same gap - one created on another device does not appear
until a reload - and so, less visibly, do resume positions and play counts. The mechanism here
generalises to them, but favorites is what was reported and what has a visible control on nearly
every screen. Playlists go in TODO.md as a follow-up rather than being fixed blind.

**Deliberately not a full sync protocol.** The host stays the single authority and the client
stays a live reader; this only removes the need to ASK at the right moment.

## Compat

- The push is additive. An OLD client never receives the kind because an old host never sends it;
  a NEW client against an OLD host just never gets the event and behaves exactly as today, which
  is the current behavior, not a regression.
- An old client receiving an unknown push kind ignores it - `onPush` already falls through
  unknown kinds without throwing. Verified rather than assumed: the handler is an if/else-if chain
  with no else.
- No stored data changes. Nothing to migrate, nothing to roll back on disk.
- A device that was OFFLINE when the change happened misses the push and picks the change up on
  its next `host:connected`, which already reloads favorites.

## Verify

- Unit: `notifyOwner` reaches a person's other devices and skips `exceptDevice`; it still reaches
  every device when no exception is given.
- Integration, two devices under one person against a real host: B favorites, A receives
  `favorites:changed` with the right kind and id, and A does NOT receive its own.
- On hardware, the exact report: favorite an artist on one phone, and the other phone's Favorites
  list and heart update WITHOUT the app being reopened. Both phones must stay in the foreground
  for the whole test, since backgrounding drops the connection and would make a later reload look
  like a success.

## Rollback

Revert. The push stops being sent, clients stop hearing it, and the app is back to reloading on
connect. Nothing persists.

## Open questions

- Should the client use the payload to patch its id sets in place rather than refetching the whole
  list? Cheaper on a large library, but it has to be right about merged mode (the sets are a UNION
  across hosts, so a removal on one host is only a removal if no other host still has it). Starting
  with a refetch, which cannot be wrong; revisit if the round-trip is felt.
