# PearTune Decisions

Append-only, newest on top. See Constitution §4.

## 2026-07-18 - App icon redesign: a Winamp-flavoured pear, centred by CROPPING TO THE BBOX
Tier: T1 (assets + a dashboard-UI recolour/logo; no wire/host-logic/persisted-shape change). Branch:
feature/app-icon-redesign (PR #55).
Context: Tim picked "app icon redesign" off the design-refresh list. The old mark (a green vinyl +
tonearm + node) was off-palette after the analog-amber rework, AND it rendered OFF-CENTRE on his Pixel.
Direction: I first rendered a hand-built 3-direction studio (amber-evolution of the old mark / a lit-VU
meter / a "pear-record"); Tim steered toward "more Winamp", so I wrote Recraft prompts (green-LCD
spectrum + metal chrome, trademark-safe - no Nullsoft lightning/llama) and he generated 7. Chosen: icon3
- a PEAR whose belly is a chrome-bezelled green-LCD spectrum analyzer. It keeps brand ownership (the app
name IS the mark; unmistakably PearTune, not a generic player) while carrying the retro-skin's green LCD,
so the launcher icon and the classic in-app skin rhyme. The pure-Winamp options (a player window, a
spectrum-in-a-frame) were rejected as too generic for a launcher icon.
The load-bearing fix - CENTRING BY BBOX, not a hardcoded transform. The OLD master centred the mark with
a baked translate/scale tuned to a specific Recraft export; when the artwork changed, the mark sat
off-centre (what Tim saw on the Pixel). The new pipeline instead measures the mark's true bounding box
(inkscape --query on the amber pear path, which encloses everything), drops Recraft's own landscape
background path, and places the bbox in a square tile via a nested <svg> with preserveAspectRatio - so
the mark is ALWAYS exactly centred regardless of the source art. Verified numerically (rendered the 52%
foreground, trimmed: margins L=R=345, T=B=245, zero diff on both axes) and visually against the Android
72dp-viewport / 66dp-safe-zone rings. Mark fills 64% of the master (inside Android's 66% adaptive crop),
52% on the adaptive foreground (launcher zoom/mask headroom). The two documented traps are honoured: iOS
PNGs have the alpha channel stripped (Apple rejects alpha), the Android foreground is padded to 52%.
Derived-asset set unchanged in shape: assets/icon.svg (master, opaque #17140f), adaptive-foreground.svg
+ adaptive-icon.png, icon.png/icon-1024.png (iOS), icon-512.png (Play), umbrel/icon.svg, all android
mipmaps, and the icon background moved #181419 -> #17140f (colors.xml iconBackground + app.json). Nested-
<svg> cropping (over a hand-computed matrix) also keeps Recraft's userSpaceOnUse gradients consistent -
they resolve inside the inner viewport, so they scale/position with the mark.
Bundled two dashboard tweaks (same visual-refresh intent, same PR):
- The connected/online `.live` dot is GREEN again. It had gone amber because it reads --primary; the
  palette rework left green only as the semantic --good. Repointed .live to --good and recoloured --glow
  (the pulse ring) to match in all three theme blocks. Safe because --glow is used ONLY by this dot - the
  radial background glow is a separate token - so nothing else changed. This restores traffic-light
  semantics: online=green, revoked=amber(warn), offline=grey.
- The dashboard's top-left brand logo is now the app icon, embedded as a 128px PNG data URI in a new
  host/ui/app/icon.js (NOT the 34KB Recraft SVG, and NOT an external file - dashboard.html must stay one
  self-contained string). .brand-mark became an <img>; the MusicNotes import stays (still used by the
  Music-source panel h2).
Verify: 289 tests + all builds green (icon assets have no test surface; the dashboard-is-a-built-artifact
test still passes). ON DEVICE: built + installed the debug APK to the TCL (new icon centred on the
launcher) and the Pixel; deployed the dashboard to the Umbrel (docker cp + restart, since server.js
readFileSync's dashboard.html at boot) and verified live - green dot beside "1 online", new pear logo
top-left.

## 2026-07-17 - A "classic" player skin: the WebView UI makes a retro amplifier face cheap
Tier: T1 (client UI only; a new persisted setting `skin`, no wire/host change). Branch:
feature/retro-skin.
Context: Tim asked "is a classic Winamp skin possible?". The load-bearing finding: PearTune's UI
is a WEBVIEW (arbitrary HTML/CSS/canvas), so a pixel-faithful vintage-amplifier player is cheap and
fully in our control - unlike the HOME-SCREEN WIDGET version, which is boxed in by Android's
RemoteViews (no canvas; a faithful look needs pre-rendered bitmap sprites, and live spectrum bars
fight the widget update throttle). So the two are separable, and the in-app skin is the high-value
one. Built a browser POC first (shown to Tim), then shipped it.
What it is: a `skin` preference (modern | classic) beside theme/density in the worklet settings.json.
Classic re-faces ONLY the EXPANDED player - a metal-chrome window with a green LCD time, a scrolling
title marquee, a live spectrum, and beveled transport. The mini bar and the rest of the app stay on
the amber theme, so collapsing always lands somewhere familiar. The RetroPlayer reads the SAME
now/status and drives the SAME controls (call('toggle'|'prev'|'next'|'seekTo'), onShuffle/onRepeat/
onStop) - it is purely presentational, no new playback surface.
Deliberate choices:
- The skin is theme-INDEPENDENT (fixed metal + green LCD hexes, not var() tokens): a skin is its own
  world, and the iconic green LCD is the point. It sits inside the amber app unapologetically.
- ORIGINAL look inspired by the classic player - PearTune-branded ("PEARTUNE" titlebar), no Nullsoft
  artwork/bitmaps (the trademark/asset line flagged in TODO).
- The spectrum is SIMULATED (bass-heavy jitter + falling peak caps, frozen/decaying when paused,
  static under prefers-reduced-motion). A REAL audio-reactive spectrum needs a native hook (Android's
  Visualizer on ExoPlayer's session, streamed over the shell->WebView bridge) - deferred, noted; most
  skins were simulated anyway.
- The marquee renders the title TWICE back-to-back with a -50% scroll, so the loop is seamless and the
  title is always on screen (a single copy left the LCD blank half the time - caught on hardware).
- It is a distinct tree from the modern expando, so the grow/shrink tween does not carry across the
  swap - acceptable for a skin the user deliberately switches to.
The MINI bar got its own classic "windowshade" face (Tim asked): when classic + collapsed, the
player is a thin metal strip - tiny green LCD time, scrolling title, a mini spectrum, play/pause, a
hairline progress line - tapping it expands to the full window. So the retro illusion holds in both
states instead of collapsing back to the modern amber bar.
The expanded window FILLS the sheet edge-to-edge (Tim asked): it was a rounded metal box floating
in the amber dock (amber caret strip above, amber padding around) - a "window in a window". Now the
metal chrome is full-bleed and square-cornered, the collapse (▾) + close (×) sit in the titlebar
where Winamp's minimize/close were, and the dock goes metal-dark under it (.dock-retro, toggled
from App - not :has(), for older-WebView safety) so nothing amber peeks at the seams. Reads as a
deliberate retro takeover, not a contained widget. The SHADE strip got the same full-bleed
treatment (Tim asked): it is edge-to-edge and square too, and .dock-retro applies whenever the
classic player is showing (mini OR expanded), so the dock is metal-dark under the strip as well -
not just the full window. (The strip's padding override needs .player.mini.retromini specificity,
since the base .player.mini padding would otherwise win.) Switching back to Modern / stopping
restores the amber dock.
The QUEUE tab became a green "Playlist Editor" when classic is on (Tim asked how far to reskin
beyond the player; chose Queue over the album grid / settings). This is the one non-player surface
with a real Winamp counterpart - its playlist window - and it is a LIST, so green-on-black reads
fine where a cover-art grid would fight the art. Deliberately CSS-forward: a `retroq` class restyles
the existing QueueScreen (metal titlebar, green numbered rows via a CSS COUNTER so no markup change,
the current row on Winamp's selection bar, played rows dimmed, times right-aligned) and EVERY
interaction is unchanged - tap-to-jump, edit, drag-reorder, remove, clear. The album/artist grid,
Settings, About, and the dashboard stay amber on purpose: no Winamp analog, and the green chrome
would clash with cover art + cramp tap targets (the opposite of why the amber-neutral chrome exists).
Deferred follow-ups (not built): the real Visualizer spectrum; a playlist window docked INSIDE the
player; the home-screen Winamp WIDGET (its own bitmap-sprite + media-session project, separate
surface).
Verify: 289 tests (UI-only; no test surface for the player face) + builds. On the TCL: switched
Settings -> Appearance -> Player skin -> Classic, expanded the player - LCD ticks, the title marquee
scrolls and stays visible, the spectrum bounces while playing and freezes when paused, and prev/play/
next/seek/shuffle/repeat all drive the real player.

## 2026-07-17 - Palette rework: "analog amber" replaces the spruce-green, across phone + dashboard
Tier: T1 (pure token values; no wire/host/persisted-shape change - the [data-theme] contract and
every var() are unchanged, only their values). Branch: feature/theme-analog-amber.
Context: Tim picked "colors/themes" off the design-refresh list and chose (from a 3-direction visual
studio rendered on a real PearTune screen) direction 2, "analog amber", over "spruce refined"
(evolution) and "ink & signal" (neutral art-forward).
The choice, and why it fits the subject: a lit-VU amber-gold (#e6b24e dark) on warm graphite, the
palette of a vintage amplifier. It keeps the deliberate WARM, LOW-GLARE dark the app already
committed to (an app you use with the screen off half the time) while giving the chrome a neutral
graphite so the ALBUM ART carries the colour on every screen - amber is reserved as the "signal"
(play, active tab, the heart you set, progress). It also sets up the deferred classic-Winamp skin.
Rejected: staying spruce (too close to a no-op) and cool-neutral "ink & signal" (drops the
intentional warmth for slightly more night glare). This is NOT one of the generic AI-design defaults
(cream+serif+terracotta / near-black+acid-green / broadsheet) - it is grounded in the music-hardware
subject.
Light mode: amber has to DARKEN to a functional bronze (#9c6a12) to clear ~4.5:1 as both button
background (white label) and accent text on cream - a light gold would fail contrast. So light reads
as warm bronze-on-cream; dark is where the amber glows. Dark is the default and the common case
(system-following), so this asymmetry is acceptable and coherent.
Scope - TWO token systems + strays, all moved together so nothing is left green:
- Phone: src/ui/styles.css [data-theme] blocks (--color-* set). Plus two hardcoded DARK-overlay
  colours that can't be var() because they sit over always-dark surfaces (the QR scanner text over
  the camera feed; the full-screen art-viewer caption over black) - moved to the new dark tokens.
- Shell strip: app/index.tsx SHELL_BG (the status-bar + WebView backing) must equal
  --color-surface-base or a cold-start flashes the old colour; updated to #17140f / #faf6ee.
- Dashboard: host/ui/app/styles.css uses its OWN shorter token names (--bg/--primary/--accent/
  --glow/--good/warn/bad) with THREE colour blocks (dark, @media prefers-light, explicit
  [data-theme=light]) - all three updated, and the radial --bg-accent glow + --glow were recoloured
  from the green rgba to amber.
- Login page: host/ui/login.js is a separate hand-written dark-only string with its own hardcoded
  palette (bg/fg/accent/danger + the on-primary button text + the error-box rgba) - updated too.
Semantic colours kept distinct from the new amber primary: error stays a warm red (#e0705f dark /
#c1362b light), success a muted green (#8bb877 / #3f7d3a) - traffic-light semantics survive a brand
recolour; warn is a hotter amber (#f2b544 / #8a5a10), used rarely and never beside the primary.
Verify: 289 tests (unchanged - values only, no logic; the dashboard-is-a-built-artifact test still
passes) + all builds. ON THE TCL (debug APK) + the Umbrel dashboard (docker cp'd dashboard.html +
login.js): dark reads warm-graphite with amber Play/active-tab/hearts/progress and album art
carrying the colour; light reads cream with the bronze accent; the theme toggle (Dark/Light/System)
switches cleanly both ways. Reset the test phone back to System afterward.

## 2026-07-17 - Session handoff v1 follow-ups: an instant-presence PUSH, position in the session row, honest paused wording
Tier: T2 (a new server->client wire message on peartune/media/1 + two new persisted fields on
the session row). Additive and backward-compatible - an old peer never registers the push type
and drops the frame, an old host never sends it, both fall back to today's lazy presence. Branch:
feature/handoff-instant-presence. Delivers the three deferred follow-ups from the 2026-07-17
session-handoff proposal at once, because they share one piece of infrastructure.

THE KEYSTONE - a server->client push. The media channel was pure request/response (req/res/chunk/
end/err). Instant presence needs the host to speak first: when device B claims the token, the
device that HELD it (A) must be told NOW, not on its next ~4s heartbeat. So `push` is appended as
message type 5 (host/presence.js + protocol/framing.js `push` + protocol/channels.js). A `Presence`
registry maps deviceKey -> live media channel(s); serveMedia registers on channel open and
unregisters on close; session.claim reads the PRIOR activeDeviceKey and `presence.notify`s it
'session-superseded'. The client (client/index.js onPush -> src/bare.js) drops the token and emits
`session:superseded` to the shell, which runs the SAME onHandedOff as the lazy path (idempotent, so
a lazy rejection landing too is harmless).
Why this does NOT compromise the design (Tim asked for the assessment before approving): the push
adds NO access surface. It only rides a channel that already exists, which only exists on a
connection the firewall already admitted; register() runs AFTER the grant check. Revoke destroys
the connection, whose close unregisters here, so a revoked device is gone from the registry and
cannot be pushed to - the push is strictly WEAKER than the connection it rides and never touches
the firewall, the grant store, or the revoke path. The only actor that gains a capability is the
host, already fully trusted. Both load-bearing rules (grant store host-local; revoke kills live
connections) are untouched, which is why this stays T2, not T3.

POSITION rides the SESSION ROW now, not the resume row (Option A, chosen over the proposal's
resolved #3). The active device carries positionMs + playing in the SAME ~4s heartbeat that already
mirrors the queue (host/state.js setSession/claimSession), so "Play here" seeks from the claim
reply ATOMICALLY - no extra round-trip, no read-after-write race against resume. The proposal's #3
(the LOSING device flushes an exact resume on handoff) was rejected because its exactness depends on
the loser being alive to flush, and the most common handoff (walk away from a backgrounded/paused
phone) is exactly when it CANNOT - so it would silently degrade to the <=8s resume, i.e. least
reliable when handoff is most common. Option A bends the proposal's tidy "position rides resume"
separation for robustness; the cost is only conceptual (position now lives in two rows), not write
traffic (the heartbeat fired anyway). Exactness at the handoff MOMENT comes from the shell forcing a
snapshot on pause (app/index.tsx toggle -> persistQueue(true)): a pause otherwise wouldn't push
(the status poll goes silent the instant playback stops), so without it another device's card would
keep saying "Playing" and a takeover would seek stale.

PAUSED WORDING (follow-up #2): the session row's `playing` flows to the card, which now reads
"Paused on X" vs "Playing on X" honestly (src/ui/App.jsx HandoffCard, worklet sessionInfo
activePlaying). The card refreshes on connect/resume/handoff, not live - the verb is correct at load
time, a known v1 limit (a backgrounded device's card can lag the other device's play/pause until it
next foregrounds).

THE HONEST LIMIT, observed on hardware: the push only reaches a loser whose worklet is CONNECTED.
A device playing from its buffer/cache with the screen off has its worklet suspended by Android and
its host connection dropped (its heartbeats stop) - so `session:claim` logs `superseded:0`, nothing
is pushed, and it falls back to lazy presence (stops when it next reconnects). This is the OS-suspend
limit flagged in the assessment, not a bug: the push tightens the alive-but-not-pushing window
(paused-connected, or the <=4s heartbeat gap) from lazy to instant, and it cannot wake a suspended
process. The two-phone test caught BOTH cases cleanly (below).
Verify: 289 tests (test/presence.test.js registry semantics incl. multi-connection + isolation +
throwing-sender; state.test.js positionMs/playing store + clamp + claim-adoption; two new
integration.test.js end-to-end-over-real-DHT tests - a claim pushes 'session-superseded' to the
prior holder carrying the winning generation + exact positionMs in the claim reply, and a self
re-claim pushes nobody). ON TWO PHONES (TCL + Pixel, host deployed to the Umbrel via docker cp, new
APK on both): the card flipped "Paused on Pixel" -> "Playing on Pixel" with the Pixel's real state;
BOTH handoff directions logged `session:claim superseded:1` and the loser's worklet logged
`session:superseded {generation:N}` ~230-460 ms after the host claim (effectively instant, vs the
old ~4s), tearing down / pausing playback at once; the taking-over device landed at ~88 s against
the source's ~84 s (the <=4s heartbeat freshness + spin-up, position transferring correctly); single
active player held throughout. The suspend fallback was also observed (`superseded:0` when the loser
had been playing from buffer screen-off, lazy takeover still correct).

## 2026-07-17 - Library sort now PERSISTS across relaunch (closing the v1 gap), and a stale closure was in the way
Tier: T1 (client only; no wire change, no host change - the sort choice rides the existing
worklet settings.json alongside density). Branch: feature/sort-persistence.
Context: the 2026-07-16 sorting entry shipped sort as per-view and IN-MEMORY, "resets on relaunch
(density persists, sort does not - acceptable v1)". This closes that gap: the per-view sort
{albums,artists,songs}:{key,order} is written to settings.json (setSettings, same path density
uses) and restored on launch. No worklet change - saveSettings already merges any patch key and
init already returns loadSettings(), so `sort` round-trips for free.
The subtlety, and it is the whole reason this was more than a one-liner: restoring the sort into
STATE was not enough. The folder host connects in the BACKGROUND, so init returns connected:false
and the first library load fires from the once-registered `host:connected` listener - whose
closure captured the FIRST render's EMPTY sort (the same stale-closure trap the nowRef/statusRef/
liveRef pattern already exists to dodge). Result on hardware: the Display sheet correctly showed
the restored Year sort, but the album list loaded in DEFAULT order. Fix: read sort through a
`sortRef` so any no-param loader sees the live value, PLUS pass explicit params on the
connected-at-init branch (setSort has not committed in that same tick - the reason applySort
already threads params directly). A pure `sortParamsFor(sortMap, view)` computes the params off a
not-yet-committed map, shared by the restore load, applySort's optimistic reload, and sortParams.
A cross-source note (benign): the sort map is global, not per-source. A songs sort saved on a
folder source, then a switch to Subsonic (which cannot sort songs and hides the control), leaves
the stored key inert - the adapter ignores an unknown/unhonored sort (falls through to default
order, per the 2026-07-16 entry) and the hidden control means the user cannot see or change it
until they switch back. Acceptable; matches how density is also global.
Verify: 266 tests (unchanged - the mechanism is a settings round-trip + a ref read; the existing
sort.test.js still pins the comparators/capabilities). ON DEVICE (TCL + Umbrel/folder): set
Albums=Year asc and Songs=Title desc, force-stop -> relaunch each time; both the loaded list
order AND the Display sheet (including the desc flag) came back exactly. First relaunch caught the
stale-closure bug (list default while sheet showed Year); after the ref fix, the cold launch
loaded year-sorted. Reset both back to Default afterward so the test phone is not left changed.

## 2026-07-16 - Library sorting is a SERVER-SIDE sort param, honestly advertised per source
Tier: T1 (adapter + UI; no wire change - `library.list` already passes params straight to
the adapter, so `sort`/`order` are additive and an old client that never sends them is
unaffected). Branch: feature/library-sorting.
Context: the Songs view had only the server's order (roughly artist/album/track); TODO
flagged sort-by-title/date/artist as needing "its own paged-rows cache or a host-side sort
param". Tim picked the approach after being reminded FOLDER is the primary user-case
([[Folder is the product]] 2026-07-14).
The decision that folder-primary drives: sort SERVER-SIDE, not with a client cache. A folder
holds the whole library in memory, so it sorts any field for free; a client-side full-library
cache would be complexity aimed only at Subsonic's limitation, which the target users do not
hit. So each adapter advertises what it can actually do in `stats().sorts`
(`{tracks|albums|artists: {keys:[...], reversible}}`) and the client shows ONLY a control the
source can honor - no dead buttons.
- FOLDER (primary): full set, both directions. Sorts copies of the in-memory _sorted* arrays
  by a canonical comparator (host/adapters/sort.js), memoized per (type|sort|order) and
  cleared on rescan - so scrolling a title-sorted list does not re-sort the library per page
  (the perf note the file already carried).
- JELLYFIN: full set, server-side via SortBy/SortOrder. Default track order (AlbumArtist,
  Album,disc,track) is preserved when no sort is sent.
- SUBSONIC (Tim's Navidrome): albums only (getAlbumList2 types name/artist/year; byYear needs
  a 0..9999 range). SONGS cannot sort - the all-songs list is an empty-query search3, which
  takes no order param - so tracks.keys is [] and the client HIDES the Songs sort control on a
  Subsonic source. Ascending only (the API has no order flag), so albums.reversible is false.
  Artists come alphabetical already, so [] (offering "name" would just reproduce the default).
The contract is canonical keys (title/artist/album/year/duration; name; name) that each
adapter maps to its own server's language, tie-breaking toward shelf order so a year- or
duration-sort stays stable within equal values. UI: a pill in the pickrow (a compact native
<select> + an asc/desc toggle shown only when reversible); on a view the source cannot sort it
becomes a faded disabled stub rather than vanishing, so the row does not reflow (the same call
the density button makes). Sort choice is per-view and persists across view switches; changing
it reloads that view from cursor 0 (new params passed straight to the loader, not read back
from not-yet-committed state).
Verify: 266 tests (test/sort.test.js brute-checks the comparators + FULL_SORTS; folder sorts
real fixtures; subsonic/jellyfin stub _call to pin the type/SortBy mapping + the songs-degrade;
unknown sort key falls through to default order). `npm run verify` green.
ON-DEVICE (TCL + Umbrel/Navidrome, 2026-07-17): the hardware pass CAUGHT A REAL BUG the unit
tests could not - the worklet (src/bare.js) built the library.list params EXPLICITLY as
`{type, cursor, limit}` and DROPPED sort/order, so the control changed the pill but the list
never reordered. The wire (client.list forwards the whole params object) and the host were both
correct; only the worklet handlers were narrowing. Fixed: tracks/albums/artists handlers now
forward sort/order. After the fix, confirmed on the TCL: Albums -> sort by Year reordered to
oldest-first (Led Zeppelin 1969, II, III, IV...); the Name/Artist/Year picker shows exactly the
Subsonic album capability (no track-only keys leak in); the Songs view correctly shows the
disabled stub (Subsonic has no all-songs sort). Also fixed a layout clip found in the same pass:
the sort <select> ("Default order") overflowed the pickrow on Albums/Artists - shortened the
default label to "Default", capped the select width, and gave the segmented picker min-width:0
so it yields space; the row now fits with no clipping. The folder FULL set (Songs title sort +
asc/desc toggle) was not exercised live - it needs switching Tim's active source, which orphans
listening state - so it rests on the unit tests. NOTE: sort choice is per-view and in-memory;
it resets on relaunch (density persists, sort does not - acceptable v1).

## 2026-07-16 - Guest grants: time-limited access, enforced at connect AND by a live sweep
Tier: T2. Proposal: proposals/2026-07-16-guest-grants.md. MVP scope (Tim): time-limited only
(library-subset `paths` deferred), created via a guest pairing window with a duration.
Context: the grant store always reserved `expiresAt`/`paths` as nulls for "v2 guest grants", and
`gate.decide()` already denied an expired grant at connect. So the groundwork existed; this is
the value change it was designed for.
What's new, and it is small: (1) `startPairing({expiresMs})` opens a GUEST window; the duration
is OPERATOR-SET, host-side, never read from the device's hello (a guest must not pick its own
expiry - the same rule as "a device may name itself but not set its own personId"). (2) pairing
stamps `expiresAt = now + expiresMs` (`grants.grant` gained the param; re-pairing an already-
granted device through a guest window REFRESHES it via a new `grants.setExpiry`, so "extend the
pass" = "scan again"). (3) a 30s periodic SWEEP (`_sweepExpired` + the pure `gate.sweepKills`)
cuts any live connection whose grant `decide()` now refuses.
The load-bearing point, and why (3) is not optional: `decide()` runs only at CONNECT. A guest
that connected before expiry would keep streaming until it happened to reconnect - the exact gap
`Connections` exists to close for revoke. Revoke fires an event we hang `kill()` on; a time-based
expiry has none, so the host sweeps. 30s lag is fine here (a SCHEDULED expiry, not the sub-second
claw-back a lost-phone revoke needs; revoke keeps its instant, event-driven kill).
The dashboard: a "Guest pass" toggle + duration picker (24h/7d/30d) in the pair modal; device
rows show a calm "guest" badge + "expires in 3h" countdown, and an amber "expired" once past.
The phone needs NO change: an expired guest experiences exactly what a revoked one does.
Deferred (follow-ups, in the proposal): library-subset `paths`; editing/PROMOTING expiry on an
existing device from the dashboard (so for now a guest is made permanent only by revoke+delete+
re-pair through a full window); a client-facing "expires in X" banner.
Verify: 248 tests (sweepKills per-branch incl. fail-closed, grant expiresAt/setExpiry, the
already-tested decide() expiry branch). On the TCL + Umbrel (host deployed via docker cp): a
2-minute guest window, TCL paired guest -> host log `pair:already-granted {guest:true}` then
`host:expired {killed:1}` ~27s past expiry (within the 30s bound) then `gate:deny {grant-expired}`
on its reconnect; the phone showed "Not connected", cached audio kept playing under the lease,
and a normal re-pair restored a permanent grant.
## 2026-07-16 - The You picker is icon-first: the active view shows its label, the rest are icons
Tier: T1 (UI only). Branch: fix/you-picker-icon-pills.
Context: the You sub-picker grew to four pills (Favorites / Most Played / Playlists /
Downloads) and, on a full-featured host, overflowed the row - the `.seg.scroll` clipped
"Downloads" and made you scroll a segmented control sideways (Tim reported it).
First cut (rejected): move Downloads to a download-icon button in the You HEADER. It fixed
the crowding but the header icon offset the centered "You" title - Tim did not want the
title pulled off-centre.
Choice: keep all four as peers, but make the picker ICON-FIRST (`.seg.icons`). Every option
is an icon; the ACTIVE one also shows its label and grows to fill (flex:1), the others
collapse to just their icon (flex:0 0 auto). Four options now fit one row with no scroll, and
the header stays centered. Icons: Heart / ChartLineUp / Playlist / DownloadSimple; each button
carries an aria-label so the collapsed icons stay accessible. The active fills to the same
edge whichever it is, so nothing offsets the page header.
Verified on the TCL: all four fit one row; tapping each expands it to icon+label and collapses
the rest; the "You" title stays centered.

## 2026-07-16 - Downloaded-album covers are cached on disk and served DISK-FIRST, not as a fallback
Tier: T1 (client-only; new on-disk store + one shim read path; no wire change, lease semantics
unchanged). Branch: feature/offline-album-art.
Context: milestone-3 phase 5C made a downloaded album PLAY offline (audio written through to
disk), but its COVER still came from a live fetch - so an offline Downloads list showed
placeholders. The last visible loose end of the offline story.
Choice: persist each downloaded album's cover bytes to disk (worklet/art-cache.js, an ArtStore
keyed by coverId - small, no LRU, bounded by the pinned-album list). pinAlbum fetches the
DISTINCT coverIds (album + tracks; usually one) best-effort at download time - a cover that
fails to fetch never fails the download. The shim serves this store, LEASE-GATED exactly like
cached audio (a revoked/long-offline device's covers go dark with its audio).
The subtlety, caught on hardware: serve DISK-FIRST, not as a catch-block fallback after the
live fetch. The first cut fell back to disk only in serveArt's catch - but offline that catch
is reached only AFTER `await ensure()` blocks on a connect timeout, so the cover loaded minutes
late or never (verified: placeholder + no art:hit, then art:hit once disk-first landed). Disk
is checked BEFORE ensure(), so offline it serves instantly.
Scoped to ONE size (DEFAULT_ART_SIZE, the size the Downloads views request): only that size
hits disk, so the online library grid (120/350/500) still fetches exact-size art, and there is
no quality regression while browsing. Store size and serve size share the exported constant so
they cannot drift. A full-screen 1200 viewer offline still shows the placeholder - acceptable
v1 (Downloads shows the cover, which was the ask). unpinAlbum frees the covers unless another
pin still shows them; UNPAIR (purgeAll) clears the whole store.
Verify: 239 tests (9 for ArtStore, incl. persistence + slash-in-coverId safety). On the TCL:
downloaded 2020 AD, wifi OFF, force-stop, cold launch - the Downloads list AND the detail
header showed the real cover (art:hit served from disk), where before both were placeholders.

## 2026-07-16 - Queue reorder/remove uses ExoPlayer's own move/remove, and the patch got cleaned
Tier: T2 (native expo-audio patch surface + a UI edit mode; no wire change). Branch:
feature/queue-reorder-remove.
Context: the queue became a persistent, first-class tab (PR #29), so "see it but can't edit
it" was the obvious gap. TODO flagged it needing "the same kind of patch as addQueueSources".
Choice: two new Functions on the expo-audio patch - moveQueueItem(from,to) and
removeQueueItem(index) - wrapping ExoPlayer's OWN moveMediaItem / removeMediaItem. NOT a
rebuild via setQueueSources: re-handing the whole playlist would restart the current track and
break gapless, which is the exact trap the addQueueSources comment already warns about. The
shell mirrors the move/remove in queueRef and fixes indexRef with a pure, unit-tested helper
(app/queue-index.js, cross-checked against a brute-force array move for every position).
Three subtleties, each a bug caught in build/test/hardware:
- currentMediaItemIndex SHIFTS WITHOUT a transition. Moving/removing an item across the
  current one changes its index but not which track it is, so ExoPlayer fires no
  onMediaItemTransition and the JS `currentQueueIndex` mirror would go stale. The native
  Functions re-sync it (= ref.currentMediaItemIndex) on the main thread, where reading the
  player is safe.
- Removing the CURRENT track needs an explicit announce(). ExoPlayer slides the next track
  into the same slot, so the index is UNCHANGED - the status listener's "index changed?" check
  never fires, and the mini-player/lock-screen would keep showing the REMOVED track. The shell
  now announces the new current explicitly on a current-track removal (verified on hardware:
  removed the playing track, mini-player advanced AND playback continued - no audio-focus loss,
  because there is no seek here, unlike playIndex's documented announce trap).
- The navbar badge reads status.queueLength, which only refreshes on a play-status tick - so a
  remove while PAUSED left it stale. The UI now updates it from the removed-queue length at
  once, the same fix the play:queued handler uses.
Also: patch-package REGENERATED the patch SOURCE-ONLY (--exclude 'android/build/'), dropping
479KB of committed build-output artifacts (763 of the old patch's 767 file-diffs were dex/class
noise; the real content is 3 .kt + expo-module.config.json). The source-build-forcing is the
`publication` block removed from expo-module.config.json - kept. This directly pays down the
"the patch is fragile" rot-risk. Re-verified: gradle built from source and the dex contains
moveQueueItem + setQueueSources (media3 has neither), proving the Kotlin compiled, not a stale AAR.
Verify: 220 tests; on the TCL, reorder (highlight follows the track), remove non-current
(badge drops), remove current paused/playing (advances, mini-player updates, keeps playing),
and force-stop -> relaunch restored the edited queue exactly.

## 2026-07-16 - A starved player must stop on IDLE, not only on a buffering-stall
Tier: T1 (client behavior; refines the 2026-07-14 graceful-reconnect T3 decision, no wire
or host change). Branch: fix/revoke-starve-clean-stop.
Context: graceful-reconnect (2026-07-14) made "a drop is not a stop" - the shell keeps the
buffer playing on host:disconnected and lets the player's fate decide: a switch reconnects,
a revoke starves. The starve was caught by ONE watchdog: dropped && isBuffering with the
position frozen past a 15s grace. That path was flagged as "never observed firing", and on
inspection it was worse than untested - it was broken for the case it exists to handle.
Finding (code + hardware): when a starved track cannot get bytes over a dead/revoked
connection, ExoPlayer exhausts its bounded retries and falls back to STATE_IDLE. expo-audio
registers NO onPlayerError listener, so a fatal error reaches JS ONLY as a single
`playbackState:'idle'` status update, with isBuffering=false. The old watchdog therefore
(a) never caught the idle terminal state (it keys on isBuffering, and RESETS its window on a
non-buffering update), and (b) could not rely on its 15s timeout either, because the periodic
status poll that would re-check the window is gated on `if(playing)` in expo-audio's
AudioPlayer.kt and goes silent the instant the player stops playing. Net: the player froze on
"buffering…" indefinitely instead of stopping.
Choice: extract the decision into a pure, unit-tested `decideStarve()` (app/starve.js,
test/starve.test.js - branch-per-test, the same discipline as host/gate.js's decide()) and add
a TERMINAL branch: `dropped && playbackState==='idle' -> starved`. The buffering-stall timeout
stays as a backstop for a source that hangs in BUFFERING rather than erroring to idle. onStarved
still fires play:lost + stop() (clear player, wipe queue), so a starve ends cleanly.
Why this is still just T1: revoke's guarantee is UNCHANGED - the host already cuts all NEW
access at connect time (killed live conn + "host refused" on reconnect, both re-confirmed on
hardware); this only fixes what the CLIENT does when its own buffer runs dry, turning a frozen
player into a clean stop. It does not let a revoked device reach anything new.
Verify: 220 tests green. On the TCL: revoked mid-play, skipped to an uncached track over the
dead connection; the MediaSession was destroyed the instant ExoPlayer's retries exhausted
(coincident with the last shim:stream-failed), NOT 15s earlier at the stall-timeout - proving
the idle branch is what stopped it. The player cleared cleanly (mini-player + queue gone).
Aside confirmed while testing: re-pairing a revoked device requires deleting its host tombstone
first (/api/device/delete) - a revoked grant is denied even inside a pairing window, which is
the fail-closed model working (DECISIONS 2026-07-14 dashboard-auth / grants).

## 2026-07-15 - The dashboard is a BUILT React app, not a hand-written HTML string
Tier: T1 (UI rewrite; NO wire change, NO persisted-shape change, NO auth-model change -
the same HTTP API, served differently). The control plane is security-relevant, so the
invariants that made the old page safe are pinned, below.
Context: host/ui/page.js was ONE 700-line hand-written HTML template literal that was
the operator control plane (pairing QR, revoke, per-person grants, source picker). It
had already produced, from its shape alone, a stored XSS (device labels concatenated
into innerHTML) and two syntax-in-a-string bugs invisible to require() (a backtick in a
comment, a duplicate const). The TODO named the rewrite a milestone: "an app, not a
dashboard." Tim asked for an app feel, everything on one screen without scrolling, the
phone app's look, and a Support Development page like the PearCircle seeder's.
Choice: a real React app under host/ui/app/ (main/App/styles/theme/api), bundled by
esbuild and INLINED into one self-contained host/ui/dashboard.html
(scripts/build-dashboard.mjs, npm run build:dashboard, in the verify gate). Layout is a
SINGLE control panel (Tim's pick over tabs): a header with live stats, a pairing panel,
a people-first Access panel (persons expand to their devices; unassigned/claimed devices
in their own group), a music-source panel (picker + folder browser + dirty-guard), and a
Support sheet. It reuses the phone app's exact theme tokens and Manrope font (imports
src/ui/fonts.js) so the two read as one product.
Why a build-time artifact and not a runtime dep: React/esbuild/qrcode are ROOT
devDependencies and NONE enter the host image. The image's Dockerfile copies host/ with
no build step, so the built dashboard.html is COMMITTED (as page.js was) and served as
one string - host/package.json stays the eleven server packages it is (DECISIONS
2026-07-14 "the host image gets its own package.json"). login.js stays a small
hand-written string (still guarded by the template-literal parse test).
Security invariants PRESERVED (this is why the tier note matters):
- XSS: React escapes every interpolated string by default, so the device label / user
  claim cannot execute. The class of bug the old page kept producing is gone. A test now
  asserts dangerouslySetInnerHTML appears NOWHERE in the dashboard source.
- The auth gate (host/ui/auth.js), the fail-closed requireSafeBind, and every JSON
  endpoint are UNCHANGED. The rewrite is client-side only.
- The folder browser still renders filesystem names as escaped JSX (was hand-built DOM
  nodes for the same reason).
- The source card's dirty-guard is kept: once the operator touches it, the 3s poll no
  longer clobbers the in-progress edit.
- Clipboard uses an execCommand fallback, because the dashboard is served over a
  non-secure origin (Umbrel proxy / LAN) where navigator.clipboard does not exist -
  the same fix the seeder uses.
Support page: the seeder's two-rail donation UI (⚡ BTC ⚡ / 💲 USD 💲 tabs, a QR per
rail, copy buttons), using PearTune's own suite addresses (Strike Lightning, on-chain
BTC, Buy Me a Coffee) - rendered entirely client-side, no phone-home.
Verify: 210 tests green (two page.js-string tests rewritten to the new architecture);
the built dashboard boots and serves on a live host (GET /, /api/state, /api/pair/start
all correct against the fixture library); a headless react-dom/server render of App
throws nothing. REMAINING manual check: open the dashboard in a browser and eyeball the
single-screen layout + the Support sheet (a screenshot cannot be driven here).
Rollback: revert the branch; page.js returns from git history and server.js requires it
again.

## 2026-07-15 - Offline revoke is a LEASE, not a purge-on-reconnect (the distinction is unreliable)
Tier: T3 (security semantics of revoke vs. offline copies). Proposal:
2026-07-15-offline-pinned-cache (this supersedes its "purge on refused reconnect" mechanism).
Context: Phase 5B lets a phone keep downloaded audio for offline playback, which relaxes
"revoke stops the music". Tim's chosen bound (AskUserQuestion 2026-07-15) was "persist, but
purge the moment a revoked device reconnects and the host refuses it" - keeping the guarantee
that a device, once online, loses its downloads. The plan relied on telling a REFUSED connect
(host up, firewall denied = revoked) from an UNREACHABLE one (timeout = server merely off),
reusing the signal pair() uses.
Finding (on hardware): the signal does NOT hold. With the host container STOPPED, the phone's
reconnect closed exactly like a firewall refusal - `conn.once('close')` fires for BOTH cases,
and the timeout branch almost never wins. So a purge-on-refused-reconnect would DELETE a
legitimate user's downloads whenever their server was simply off. That is the exact failure
the proposal warned about. Root cause: at the connection layer a revoke and a dead host are
indistinguishable (both just close); the client cannot tell them apart without host help.
Choice (Tim, 2026-07-15): a client-only LEASE. Every successful connect stamps `lastAuth`;
cached/downloaded audio is served from disk only while `now - lastAuth < 14 days`. A revoked
device never re-authorizes, so its downloads go dark after the grace; a device whose server is
off re-authorizes the instant it is back, so it never loses anything. Files are NOT deleted on
expiry - re-pairing (a fresh authorization) makes them playable again. UNPAIR remains a
deliberate, reliable purge (it wipes audio + cached state + the lease). The reconnect-refusal
purge is removed entirely.
Alternatives: (a) a host "you're revoked" signal (admit a revoked device to a tiny channel,
tell it, then close) - reliable instant purge, but softens the firewall-denies-at-connect model
and is more T3 host surface; deferred, revisit if instant claw-back matters. (b) keep trying to
distinguish refused vs. unreachable - rejected, proven unreliable.
Consequences: a revoked device may play its existing downloads offline for up to 14 days
(bounded, and it can capture the current stream anyway - same reasoning as graceful-reconnect
2026-07-14). "Revoke cuts all NEW access within a second" is UNCHANGED (browse / next uncached
track / art / new download denied immediately). The relaxation is only for already-downloaded
bytes, now time-boxed instead of promised-instant.

## 2026-07-15 - Emby is a SHIM on the Jellyfin adapter, not a new source kind
Tier: T1 (no wire change, no new persisted kind/field, no migration)
Context: the compatibility roadmap ranked Emby second (Family 2). Emby is in the Umbrel
official store, and Jellyfin forked Emby ~2018, so the roadmap called for "a shim, not a
rewrite".
Finding: the endpoints are the same (/Users/AuthenticateByName, /Items, /Audio/{id}/
stream?static=true, /Audio/{id}/universal, /Items/{id}/Images/Primary, /System/Info/
Public). The ONLY delta is where auth goes: Jellyfin reads identity+token from
`Authorization: MediaBrowser Client=..., Token="..."`; Emby reads identity from
`X-Emby-Authorization` and the token from a separate `X-Emby-Token` header.
Choice: SEND BOTH header flavors on every request (_authHeaders()). Each server reads the
one it knows and ignores the other, so ONE code path serves both with no server-sniffing
branch. Emby rides the existing 'jellyfin' kind (the DECISIONS 2026-07-14 Jellyfin entry
already anticipated this - "how an eventual Emby adapter will label itself without a new
source kind"). The picker button becomes "Jellyfin / Emby"; the app still shows the
server's OWN name via ProductName ("Jellyfin" vs "Emby Server"), so nothing is guessed.
Why no new kind: a new 'emby' kind would be a T2 (persisted config + trackId re-scoping)
for zero benefit - the adapter, endpoints and mapping are identical, and sourceName
already distinguishes the two servers to the user. Keeping one kind avoids a migration and
matches how 'subsonic' covers many servers (DECISIONS 2026-07-15).
Verify: unit tests pin that both header flavors are sent and the token lands in BOTH the
Authorization header and X-Emby-Token. Live: probe a real Emby on the Umbrel (browse +
stream via the Emby headers), and confirm Jellyfin is unregressed.

## 2026-07-14 - A drop is not a stop; revoke cuts NEW access, not the current buffer
Tier: T3. Proposal: proposals/2026-07-14-graceful-reconnect.md (approved by Tim)
Context: switching networks (wifi<->cellular) killed the P2P connection, and the shell
reacted by calling stop() - tearing the player down AND wiping the queue. A five-second
network blip cost you the whole queue. That teardown existed because a revoke and a
network drop look IDENTICAL at the instant of disconnect, and stopping was the safe
reaction that made "revoke stops the music within a second" true.
Decision (Tim): revoke does not need to cut the CURRENT track's already-buffered audio.
It needs to cut everything NEW. A revoked device may finish what ExoPlayer already
buffered; it may not start the next track, browse, search, or fetch art or any new
bytes. Sound against the real threats (lost phone, removed guest) - they hear the tail
of one song, nothing more - and revoke never stopped a determined client from capturing
the current stream anyway.
The key: a revoke and a switch look identical at disconnect but DIVERGE ON RECONNECT -
a switch reconnects, a revoke is denied. So the phone stops guessing at disconnect time.
Implementation (client only, no wire change):
- The shell no longer calls stop() on host:disconnected. It keeps the player and the
  queue and proactively reconnects.
- The shim ALREADY reconnects on demand (every request awaits ensure()), so ExoPlayer's
  next chunk request rides through the blip - a switch is a stall the buffer usually
  hides; a revoke is denied and the buffer starves.
- STARVATION net: if the player sits buffering (isBuffering true - which distinguishes a
  starve from a user pause) with position frozen for 15s while disconnected, the buffer
  ran dry and we cannot get back in - stop, and say "lost the connection" (NOT "revoked":
  from the phone a revoke and a tunnel are the same, per the 2026-07-14 background
  entry).
VERIFIED on the TCL: played a track, revoked it from the dashboard. host:revoked killed
the live connection, gate:deny {reason: device-revoked} denied the reconnect (NEW access
cut off), and the player kept playing its buffer (the whole small track was buffered) -
exactly the policy. Playing-to-end-of-a-buffered-track and the wifi<->cellular switch
were verified separately (switch on the Pixel; the starvation timeout is reasoned from
isBuffering + frozen-position and observed only indirectly - a large FLAC revoked
mid-buffer is the case to confirm).
The acceptance test in CLAUDE.md changed accordingly: "revoke stops the music within a
second" -> "revoke cuts all NEW access within a second; the current track may finish".

## 2026-07-14 - ffmpeg SPIKE: the transcoder was the easy part; delivery is a client+shim project
Tier: T1 (host groundwork landed; the shippable feature is deferred with findings)
Context: the folder-first strategy named "ffmpeg in the folder adapter" the
highest-leverage move, because transcoding (capping a FLAC for cellular) is the main
thing a server connector had over a folder. Spiked it.
What the spike PROVED, and it is the cheap half:
- The folder adapter can transcode. Behind the existing `format`/`bitrate` params it
  spawns ffmpeg and streams stdout. Measured FLAC -> mp3@128k at ~7x smaller,
  ~50x realtime; opus@96k ~14x. If ffmpeg is absent it falls back to raw bytes - never
  an error - so the box degrades to exactly the pre-spike behavior. Tested.
- Image cost is NOT the apt `ffmpeg` metapackage (466MB, nearly doubles the image). A
  per-arch STATIC ffmpeg binary is ~40MB (amd64) / ~19MB (arm64) compressed, fetched
  in the Dockerfile. ~10% image growth, not 2x.
What the spike DISCOVERED, and it is the real cost - the phone cannot receive a
transcode today, for two reasons:
1. The client never REQUESTS one. `media.stream` carries `format`/`bitrate`, but the
   worklet/shim never set them. (This was always true; the "bitrate adapts to network"
   entry of 2026-07-13 was a plan, never built on the client.)
2. THE SHIM IS BUILT ON BYTE RANGES, and a transcode has none. worklet/shim.js reports
   the track's exact size as content-length, answers 206 with content-range, and
   ExoPlayer seeks by byte offset - all of which require stable byte offsets that a
   transcoded stream does not have (byte 5,000,000 of the mp3 does not exist until
   ffmpeg makes it, and its size is unknown until it is done). Serving a transcode means
   a non-seekable 200 stream with no content-length, and seeking becomes "re-transcode
   from a time offset with -ss". That is a real rework of a PROVEN component.
The reframing: "cellular transcoding" is NOT a folder-adapter change. It is a
CLIENT + SHIM project (detect network -> request format/bitrate; shim serves a
length-unknown non-seekable stream; seek = re-transcode with -ss), and it is
SOURCE-AGNOSTIC - the same work lights up Navidrome and Jellyfin transcoding too, which
have the identical latent gap. So it is more valuable than a folder feature, but it is
also more than "add ffmpeg."
Choice:
- LAND the host-side transcoder now, as groundwork. It is correct, tested, gated behind
  params nothing sends yet, and harmless (inert until requested).
- Do NOT add ffmpeg to the shipped image yet - 40MB of dead weight until the client can
  ask for a transcode. Add it together with the client+shim work.
- Track "cellular transcoding" as its own milestone (client network policy + shim
  transcode-mode), NOT as a folder task. It is the honest next step, and it benefits
  all three sources at once.

## 2026-07-14 - Folder is the product; a connector inherits a server, it does not fetch music
Tier: T1 (strategy / roadmap direction, no wire change)
Context: with the folder adapter now reading tags, Tim asked the sharp question - if
every music server just points at folders on disk, and we can point at those same
folders, what does connecting to Navidrome/Jellyfin/Subsonic actually BUY over folder
mode? Worth writing down before we spend effort adding more connectors.
The framing that settles it: **a connector does not fetch the music - the bytes are in
folders either way. It inherits the server's LIBRARY MODEL and SERVICES.** Concretely,
what a connector gives that a folder does not, ranked by how defensible each is:
1. TRANSCODING. Navidrome/Jellyfin transcode FLAC -> a capped bitrate on the fly; the
   folder adapter ships no ffmpeg, so a raw-FLAC folder over CELLULAR is ~1GB/album.
   For "playable anywhere" that is the case that matters. BUT it is replicable: ffmpeg
   in the host image (already a backlog item) would give folder mode transcoding too,
   which would erase this advantage. This is the biggest reason to connect AND the one
   we could most easily make moot.
2. INHERIT WHAT THE USER ALREADY CURATED. Someone running Navidrome has playlists,
   favorites, ratings, fixed artwork, a chosen album grouping. Connecting shows them
   THE SAME library they already see; a folder re-scan cannot inherit playlists or
   curation. This is the DURABLE reason connectors exist - consistency with an
   existing setup - and folder mode structurally cannot cover it.
3. MUSIC THAT IS NOT A MOUNTABLE LOCAL FOLDER. We hit this with Nextcloud (files live
   in its data dir; folder mode needed a bind-mount). Plex/Jellyfin can span network
   shares or cloud mounts the host cannot easily reach. The server abstracts "where
   the bytes physically are."
4. The server already scanned/indexed and watches for changes; folder mode re-scans at
   boot and needs a manual Rescan.
The counter-evidence, measured on Tim's own box: his Jellyfin GROUPED THE SAME FILES
WORSE than folder mode - 10 folder-lumped "albums" (one of 667 tracks) vs folder
mode's 604 clean tag-grouped albums (which matched Navidrome within a few percent). So
for a plain, well-tagged local folder, the connector was strictly worse EXCEPT it can
transcode. That is the whole tradeoff in one example.
Decision / direction:
- **Treat folder mode as the product, not the fallback** (the code has always hinted
  this: "the fallback and arguably the real product"). It is the only source that
  works for 100% of users, including everyone with no server.
- **The connectors worth keeping are the ones that give something a folder cannot:**
  Subsonic (cheap, broad, matches what server-runners already see) and Jellyfin
  (Start9 has nothing else - DECISIONS 2026-07-14 platform survey). Be skeptical of
  chasing the bespoke long tail (Koel/Polaris/mStream) - the compatibility roadmap in
  TODO.md ranks them low for this reason.
- **The highest-leverage investment is ffmpeg in the folder adapter**, because
  transcoding is connectors' biggest edge and adding it to folder mode gives cellular
  playback to EVERYONE, not only to people who run Navidrome. Pair it with .m3u
  playlist reading and folder mode covers most of what connectors do.
Net: the value-add of a connector is "inherit my existing server's
playlists/curation/transcoding," not "get my music." Build breadth of connectors only
where they deliver that; otherwise pour effort into making folder mode great.

## 2026-07-14 - The app shows the server's OWN name, not the source KIND
Tier: T1 (app UI + adapter stats field; no wire break - stats is free-form JSON)
Context: the source indicator first showed the KIND ("Subsonic"), which is a lie when
the kind 'navidrome' is actually serving Nextcloud Music or LMS. Tim: "Should
'Subsonic' be the source when it's really Nextcloud?"
Finding: we do not have to guess or sniff the URL. **The server names itself.** Every
Subsonic response carries `type` ("navidrome", "nextcloud music", "gonic", ...) and
usually `serverVersion`; Jellyfin's System/Info/Public carries ProductName ("Jellyfin"
vs "Emby Server") and Version. The adapters capture these (Subsonic off any response;
Jellyfin off one unauthenticated call at scan) and report a `sourceName` in stats().
Choice: the app prefers `sourceName` (the server's own name) and falls back to a coarse
kind label only for an older host that does not send one - where 'navidrome' stays
"Subsonic" (the honest umbrella, since the kind is shared across all Subsonic servers).
Verified on the TCL against the real Umbrel: the header reads "Nextcloud Music" while
serving Nextcloud, "Folder" on the folder source.
Consequence: this is also how an eventual Emby adapter will label itself without a new
source kind - ProductName already says "Emby Server".

## 2026-07-14 - The folder adapter reads TAGS, and infers albums from them
Tier: T2. Proposal: proposals/2026-07-14-music-sources.md
Context: the folder adapter listed filenames and nothing else. It is the DEFAULT for
anyone without Navidrome - a store install lands here - so "a library of filenames"
was the first impression of the whole app for exactly the people with no server.
Choice: parse tags with `music-metadata` (MIT: ID3, Vorbis, MP4, RIFF). We are not
writing a tag reader; a decade of other people's broken tags is baked into that
library and none of it into ours.
The interesting part is not reading a tag, it is deciding WHAT AN ALBUM IS in a bare
folder, and getting it wrong gives you 400 albums called "Greatest Hits" or one album
per track. Three cases, in order:
1. An ALBUMARTIST tag - trust it completely. (albumartist, album) is the album,
   wherever the files sit. This is what merges Disc 1/ and Disc 2/ back into one
   album, and the only signal that survives a library organised by year or genre.
2. An album tag but NO albumartist - group by (DIRECTORY, album), never by (track
   artist, album). The second splinters every compilation into one album per guest
   performer. A directory is the strongest statement a folder makes about what belongs
   together. A compilation with differing performers and no albumartist is labelled
   "Various Artists" rather than whichever track was first off the disk.
3. No album tag - the DIRECTORY is the album. Untagged rips live in a folder named
   after the album roughly always.
Other choices that matter:
- Artwork is an adjacent cover.jpg/folder.jpg (usually the better scan, and one open()
  instead of parsing a 40MB FLAC) or the embedded picture, resolved LAZILY per album
  and cached - including MISSES, or an album with no art re-parses its files on every
  scroll. The scan skips covers entirely; holding 1358 embedded JPEGs to build a track
  list would cost hundreds of MB for art nobody asked to see.
- A file with unreadable tags is STILL A TRACK (filename as title). Losing a playable
  file because we could not read its tags would make the tag reader worse than none.
- trackId stays the PATH, not the tags. A library whose ids changed when someone fixed
  a title typo would orphan that track's play count (see the 2026-07-13 id entry). A
  NEW `groupId()` mints stable album/artist ids for a source that has none of its own;
  it is deliberately NOT a ledger key, so its derivation can change later. trackId's
  cannot.
- A missing folder THROWS with the list of what the container CAN see, instead of
  reporting 0 tracks. "0 tracks" is indistinguishable from an empty library, and that
  is exactly the trap that cost an evening (below).

## 2026-07-14 - ONE CONFIG PER KIND; switching sources keeps the other's credentials
Tier: T2 (persisted config shape). Proposal: proposals/2026-07-14-music-sources.md
Context: Tim went Navidrome -> Folder -> Navidrome and the URL, username and password
were gone. source.json held ONE flat config, so saving a folder overwrote the
Navidrome credentials.
Choice: source.json v2 is `{ version, active, sources: { navidrome, jellyfin, folder } }`.
`active` is a POINTER; each kind keeps its own row. Flipping between them is free, the
dashboard prefills any kind, and this is also the shape MULTIPLE SIMULTANEOUS SOURCES
will need (the direction this is heading - see the combined-source trap in the
2026-07-13 trackId entry: a merged library needs a dedup story because trackId is
source-scoped).
Compat: v1 flat configs migrate on read (migrate()). Tim's Umbrel has a v1 file; it
keeps working, password intact, and the credential surviving the upgrade is the whole
point - losing it would take the library dark on a restart. Passwords still never
leave the host (the view reports has-a-password, not the password); a blank field
still means "leave it alone", now read from the STORE rather than the live adapter,
which is what lets a kept Navidrome password survive while a folder is serving.

## 2026-07-14 - Jellyfin ships; PLEX does NOT (and not for legal reasons)
Tier: T2 (new source kind). Proposal: proposals/2026-07-14-music-sources.md
Context: the release phase named Jellyfin and Plex as the two server adapters to add
alongside Navidrome. Plex was to be spiked first and dropped if it turned ugly.
JELLYFIN: shipped. Same interface as Navidrome, mostly mapping. Username + password
exchanged ONCE for an access token that does not expire until revoked; no cloud, no
refresh, no third party. The token lives in memory; the PASSWORD is what we persist,
because a cached token we could not refresh would strand the library on the first
restart after the operator logged us out elsewhere. A stable deviceId (derived from
libraryId) keeps Jellyfin's device list from filling with ghost PearTunes. Verified
against a live server: auth, listing, album/artist detail, search, exact-byte
streaming, Range 206, artwork, and the cold-restart id-rebuild path.
PLEX: spiked, DECLINED. The reads are comparable to Jellyfin. The killer is auth:
- There is NO local credential. Plex Media Server has no username/password endpoint;
  every authenticated read is gated by a token minted at plex.tv. So a headless host
  reading a disk three feet away must (a) run a browser-mediated plex.tv/link flow at
  setup, and (b) as of Sept 2025 keep a ROLLING 7-DAY cloud refresh loop alive for the
  life of the install (nonce -> sign an Ed25519 device JWT -> exchange), forever.
- The only escape is `allowedNetworks` ("allowed without auth"), which means telling
  the user to WEAKEN their Plex server's security - a grotesque thing for THIS app,
  whose pitch is "do not expose your server", to ask.
A dependency on plex.tv being reachable every 7 days, so the daemon can read a local
file, is precisely the failure mode PearTune exists to abolish. We would be shipping
it on purpose, in the always-on process.
IMPORTANT, so nobody re-opens this on the wrong grounds: this is a decision on COST and
ARCHITECTURE, NOT on legality. Plex published an official, versioned API in Sept 2025
and applauded the reverse-engineers; the ToS explicitly contemplates "client
applications that communicate directly or indirectly with the Plex Solution"; music is
EXPLICITLY exempt from the 2025 remote-playback paywall; and there is no enforcement
history against clients (Plezy does exactly this in the open today). If we ever revisit
- the argument for reach is real, Plex's install base dwarfs the others - do it after
  milestone 4, JWT-flow only, music-only (the paywall exemption is audio-shaped; video
  would invert the whole calculus), and never instruct anyone to set allowedNetworks.

## 2026-07-14 - The folder path is a CONTAINER path, so the dashboard must not guess
Tier: T1 (dashboard + adapter). Proposal: proposals/2026-07-14-music-sources.md
Context: Tim typed the path Navidrome uses on the HOST
(/home/umbrel/umbrel/home/Downloads/music) into the folder field and got zero tracks.
Correctly - that path does not exist INSIDE the container, only what is MOUNTED does
(/music) - but "0 tracks" is indistinguishable from an empty library, so it reads as
"this app is broken" rather than "that path is wrong". It cost a real evening.
Two compounding facts made it worse: the compose mounted an EMPTY docker volume, so
even the right path had nothing; and nothing anywhere said "container path".
Choice: a free-text box the host cannot verify is the bug.
1. A folder BROWSER (/api/source/folders): the dashboard lists the directories the
   container can actually see, flags which ones contain music, and the operator PICKS
   one. The value that fills the box came from something that provably exists. Built
   with DOM nodes, not string concatenation - these names come off a filesystem, onto
   the page that holds the revoke buttons (see the stored-XSS entry).
2. Test on a missing path THROWS a sentence naming what IS visible, instead of "0
   tracks". Test that reaches a real but empty folder says "reachable, but NO MUSIC in
   there" - zero tracks is not a pass.
3. The Umbrel compose mount was simply WRONG: ${UMBREL_ROOT}/data/storage/downloads is
   empty on a real Umbrel. Navidrome's own app mounts ${UMBREL_ROOT}/home/Downloads,
   which is where the files are (verified: 1357 tracks there, 0 in the old path). The
   compose now mounts that, defaulting the library to its music/ subfolder, with the
   whole Downloads dir visible so the picker can reach podcasts/ and audiobooks/ too.

## 2026-07-14 - The music source is DATA, not deployment
Tier: T2 (new persisted config + new dashboard API)
Context: preparing the community-store listing. A store install has no env vars, so
it would land on the folder adapter - which has no tag reading - and the user would
get a library of FILENAMES. Nobody installing an app from a store is going to
hand-edit a docker-compose file to point it at their Navidrome.
Choice: the source lives in the host's own data dir (source.json, 0600 - it holds a
password), chosen in the dashboard. Precedence: source.json > env/CLI > folder. The
operator's choice therefore SURVIVES a restart with different env vars, which is the
whole point.
Details that matter:
- The adapter is swapped ATOMICALLY and only after the new one scans. Wrong
  credentials throw and the OLD source keeps serving: a library going dark is not an
  acceptable way to learn you mistyped a password. The dashboard has a Test button
  for the same reason.
- media.js takes a getAdapter() GETTER, not an adapter. A connection outlives a
  source change, and a phone still streaming from the source you just switched away
  from is a bug you would not find for weeks.
- A BAD saved source does not stop the host from starting. If it did, the operator
  would be locked out of the very dashboard they need to fix it.
- The password is never sent to the browser (publicView). A blank password field on
  an already-configured source means "leave it alone", not "set it to empty".
Verified on the Umbrel with a container that had NO Navidrome env vars: 0 tracks
(folder) -> configured from the dashboard -> 1358 tracks, and it survived a restart.

## 2026-07-14 - The dashboard gets a LOCK, because the host must own the network
Tier: T3 (auth gate). Proposal: proposals/2026-07-14-dashboard-auth.md
The chain of facts, each one measured rather than assumed:
1. **The host needs `network_mode: host`.** Re-tested today on the Umbrel with the
   real image: under Docker's default bridge the firewall ADMITS the client
   (gate:allow-for-pairing) and the connection dies before the pair channel opens.
   Bridge NAT is a second layer of NAT; holepunching does not survive it.
2. **Host networking means Umbrel's app_proxy cannot front us.** The proxy is a
   container on a bridge network and cannot reach a service bound to the host's
   loopback. Umbrel's own host-networked apps (Plex, Home Assistant) skip the proxy
   and serve their UI straight onto the LAN, protected by their own login.
3. **The proxy was the only thing standing in for our missing auth.** The dashboard
   had none BY DESIGN (DONE 2026-07-13), which was fine while it was loopback-only.
So the dashboard now has its own lock: PEARTUNE_PASSWORD (umbrelOS passes
${APP_PASSWORD}), a session cookie, a constant-time compare, and a 5-strike
rate limit.
THE RULE THAT MATTERS: **the host REFUSES TO START** if told to bind a non-loopback
address with no password. Not a warning - an exit, before it joins the DHT. A
warning in a log nobody reads is not a control, and every "expose it just for a
minute" is how a revoke button ends up on an open port forever.
Not in scope: TLS. On a home LAN the password crosses in the clear, which is what
every other Umbrel app does; a self-signed cert would only train people to click
through warnings. Say it in the README instead of pretending.

## 2026-07-14 - The host image gets its OWN package.json
Tier: T1 (build)
The image would not build at all: the repo root is the PHONE APP (React Native,
Expo), it runs `postinstall: patch-package` for the app's expo-audio patch, and
patch-package is a devDependency - so `npm ci --omit=dev` installed no patch-package
and then ran it anyway. Exit 127, every time.
`--ignore-scripts` is NOT the fix: it also skips the native postinstalls the
hypercore stack needs, and you get a runtime that half-works and then aborts.
Choice: host/package.json with the ELEVEN packages host/, client/ and protocol/
actually require. The image stops dragging React Native and Expo into a server that
has no use for either. Keep the versions in step with the root by hand: same wire,
and a skew between phone and host is a protocol bug waiting to happen.

## 2026-07-14 - Device and user naming: a device names ITSELF, an operator confirms
Tier: T2. Proposal: proposals/2026-07-14-device-and-user-naming.md
Context: two phones paired, and the dashboard showed two rows called "Android
phone". Per-person grants existed and worked; the operator had nothing human to
look at, so the feature was complete and unusable.
Findings that made this smaller than it looked:
- `deviceHello` ALREADY carries a label, the host already stores it, the dashboard
  already renders it. We were hardcoding "Android phone". Naming a device at pair
  time is a T1 with no wire change.
- The host ALREADY has a people model (person rows, assign, revoke-person). What
  was missing was any way for the phone to SAY who it belongs to.
Choice: no framing change (adding a field to deviceHello would break old peers -
that is the T2/T3 line). Two new METHODS on the media channel instead, which
carries {method, params} JSON already, so an old host answers ENOMETHOD and a new
app degrades to "renaming needs a server update".
The rules that let a client write into the host's authority store at all:
1. The caller is the NOISE-AUTHENTICATED connection. identity.set takes no device
   key - there is nothing to forge, and a device can only write its own row.
2. A device may NOT set personId. It CLAIMS a name; the operator confirms it.
   Today personId only drives revoke-by-person, so self-assignment would be
   harmless - but the moment per-person scopes, playlists or history exist, a
   device that can attach itself to any person by name is an escalation.
   Self-declared identity must not become authority.
3. A claim grants nothing. It is cosmetic until confirmed.
4. Names are sanitized at the HOST (trim, cap 64, strip control chars) and escaped
   at the render.
Re-pairing an already-granted device now UPDATES its label (it can rename itself
over the media channel anyway, so refusing here would protect nothing and only
surprise people) but never touches personId or the claim.

## 2026-07-14 - STORED XSS ON THE DASHBOARD (found while building naming; fixed)
Tier: T3-adjacent (the dashboard is the control plane)
The device label arrives in deviceHello from ANY device that reaches the pairing
window, and host/ui/page.js interpolated it RAW into innerHTML - and into a
revoke() onclick attribute. That is a stored XSS on the page that holds the revoke
buttons and the pairing QR.
It predates this work: with the label hardcoded to "Android phone" nobody would
have noticed, and the naming feature is what made it obvious (people type names).
Fixed: every device- or operator-supplied string is escaped at render; the revoke
button now carries the device KEY only and looks the label up from data. A test
asserts the escaper is used, because this is the kind of fix that quietly rots.

## 2026-07-14 - An artist with NO ALBUMS is not empty, and search groups collapse
Tier: T1 (host adapter + UI)
Context: Tim searched "krutch", got artist results, and long-pressing one to add it
to the queue failed with "nothing to play there". Opening it showed no albums and
no songs.
Root cause, and it is a Navidrome data fact, not a bug in our code:
**Navidrome mints an artist row for every COMPOSITE TAG string it meets** -
"Thousand Foot Krutch/COFER", ".../Karmageddon", ".../Red". A search for "krutch"
returns ONE real artist (18 albums) and NINETEEN participant rows with
`albumCount: 0`. They have songs; they have no albums of their own. Our artist page
is built on "an artist IS its albums" (one getArtist call), so those rows were a
dead end.
Choices:
1. An album-less artist falls back to its SONGS. There is no getSongsByArtist in
   Subsonic and getTopSongs answers empty for these (tried it) - `search3` on the
   exact name works, filtered to an EXACT artist match, because a substring search
   for "Thousand Foot Krutch" would drag in the primary artist's whole catalogue.
2. **Search ranks artists with albums FIRST.** The server's own order buried the
   one artist you were obviously looking for underneath nineteen featured-on rows.
3. The participant rows carry no coverArt (Navidrome answers them with its default
   white-star image; a wall of those looks worse than our own placeholder), and no
   "0 albums" label - a true thing to say, and a useless one.
Search results are now COLLAPSIBLE GROUPS with counts (Artists 20 / Albums 18 /
Songs 50). Each opens independently - this is deliberately NOT an accordion, since
you often want the artists AND the songs, and closing one to see the other is the
same tedium in a different shape. A group with <= 5 hits opens itself: making
someone tap to reveal two results is a worse tax than the scrolling was.
Also: a transient failure ("nothing to play in X") is now a TOAST, not a red banner
nailed to the top of the screen until something else clears it.

## 2026-07-14 - The queue is a TAB, and playIndex must not announce
Tier: T2 (native patch + player)
Context: Tim asked for a way to play or queue an album/artist without drilling into
its track list, and then asked whether the queue indicator belonged somewhere more
persistent than the player.
Choice: a fourth navbar tab (Library / Queue / Settings / About) carrying a COUNT
BADGE, plus Play / Shuffle / Add-to-queue on the album and artist screens and on a
long-press of any tile. The mini-player's own queue pill was REMOVED once the tab
existed - two copies of the same number, inches apart, is noise.
Honest caveat, and it is the interesting one: **stopping playback still throws the
queue away.** The queue IS the playlist inside ExoPlayer; there is no persisted
queue that outlives it. So the Queue tab is empty whenever nothing is playing. If
that becomes annoying, the fix is queue PERSISTENCE in the worklet (restore on
launch), not a different place to put the button.

ADD TO QUEUE required a new native method: `addQueueSources` in the expo-audio
patch. It is addMediaSources, NOT setMediaSources - re-handing ExoPlayer the whole
playlist would reset the current item and restart buffering, i.e. interrupt the
song the user is listening to, which is the exact opposite of what "queue this for
later" means. No prepare() either, unless the player is IDLE (the "nothing is
playing, queue an album" case), because prepare() on a live player stutters.
Verified in the dex (`strings | grep QueueSources`) and on the phone: queued an
album mid-song, the track kept playing, the counter went 1 -> 2.

THE BUG THAT COST THE MOST, and it is worth writing down because it looks like it
should work: **playIndex (tap a queued track to jump to it) must NOT call
announce().** setActiveForLockScreen tears the MediaSession down and builds a new
one, and doing that in the same breath as a seek loses the AUDIO FOCUS with it. The
jump appeared to work - the right track loaded, the UI updated - and it landed
PAUSED, silently. The status listener already announces when it sees the index move
(that is how gapless advance updates the lock screen), so the correct code is: seek,
play, and let it notice.

## 2026-07-14 - Navidrome DOES have an all-songs endpoint. The Songs view is back
Tier: T1 (host adapter)
Context: this repo has said since milestone 2 that "Subsonic has no all-songs
endpoint", which is why the flat track list was abandoned (it could only ever show
the first page of albums walked) and albums became the way in. Tim asked for a
Songs view anyway, so I went and asked the actual server.
Finding: **Navidrome (OpenSubsonic) answers `search3` with an EMPTY query as
"everything", and it pages by `songOffset`.** Measured against the real library:
all 1358 songs, and songOffset=1000 returns the expected rows. So a Songs view is
a paged list, not a 60-call album walk. The old claim was true of strict Subsonic
and false of the server we actually target.
Choice: `list({type:'tracks'})` uses the empty-query search3, and FALLS BACK to the
album walk if the server refuses. The fallback matters: an empty first page is
indistinguishable from "not supported", so an empty first page is treated as
unsupported rather than as "this library has no music". Past the first page, empty
means the end - do not re-walk.
What we still do NOT get: sorting. The order is the server's (roughly artist /
album / track). Sort-by-title would mean pulling all 1358 rows into the phone
first, and we are not doing that for a scroll.

## 2026-07-14 - Grid density is ONE control, and 4-up is not on it
Tier: T1 (UI)
Context: Tim proposed a grid/list toggle AND a 2/3/4-per-row picker.
Choice: one control, cycling List -> 2-up -> 3-up. No 4-up.
Why: "grid or list" and "how many per row" are the same axis - density - and
splitting them gives four states to explain and test for one decision. 4-up on a
phone is an ~85px cover, too small to recognise the art, which is the only reason
a grid exists at all; a list serves that density better and shows the full title.
Consequence worth having: the ART SIZE now follows the density (list 120px, 2-up
500px, 3-up 350px). Covers were being fetched at a flat 300px into a ~500px 2-up
tile, so they were already slightly soft, and a 500px cover behind a 52px list row
is bytes crossing a P2P link for nobody. The UI composes the art URL itself (the
worklet hands it a base URL) so changing density does not re-list the library.

## 2026-07-14 - Predictive back is OFF. It breaks the back button
Tier: T1 (Android)
Context: Android 14+ predictive back (`android:enableOnBackInvokedCallback="true"`)
animates a peek of what is behind the app during a back gesture. Expo scaffolds it
as "false"; I turned it on and tested it on the TCL.
Result: **it broke the back button.** With the flag on, the first back press from
the About tab CLOSED THE APP instead of popping back to Library. React Native
0.81's BackHandler is not routed to the platform's new OnBackInvokedCallback here,
so the system takes the press and finishes the Activity - and our entire nav
contract (shell:navState + a 'back' event, with the shell only swallowing the
press when the UI has something to pop) is bypassed.
Choice: reverted. The flag stays "false" until React Native routes the new callback
to BackHandler.
Worth being clear about what we are NOT missing: predictive back could never have
animated OUR screens anyway. PearTune is one Activity hosting a WebView, and the
nav stack (album, artist, sheets) is React state the system knows nothing about.
Animating those needs OnBackAnimationCallback, which RN does not expose. The only
thing the flag buys is a nicer animation when back CLOSES the app - and it charged
a broken back button for it.

## 2026-07-14 - The background disconnect is EXPECTED. Reconnect on demand
Tier: T1 (client behavior)
Context: Tim noticed the app loses its connection to the host about a minute after
going to the background while idle. Measured on the TCL: the host logs
`media:channel-closed` roughly 20 seconds after the app is backgrounded.
Why it happens: Android suspends a backgrounded app that is not holding a
foreground service. It stops sending keepalives, and the link times out. This is
not a PearTune bug and cannot be "fixed" at our layer.
What is NOT broken, and this is the important measurement: **while a queue is
loaded - playing OR PAUSED - the link survives.** The media session keeps the
process alive. Verified: paused with a queue, backgrounded 75 seconds, pressed
PLAY on the media keys, audio resumed over the still-live connection. The case
that actually matters for a music player already works.
Choice: let the idle link die, and reconnect ON DEMAND rather than holding it open.
1. A permanent foreground service WOULD keep the socket alive, and we are not doing
   that: a permanent notification and a battery cost, so an idle app can hold a
   connection nobody is using.
2. `ensureConnected()` in the worklet revives the link for ANY caller that needs
   it, behind a single-flight promise (a screen coming back fires albums + artists
   + a dozen art requests in one tick; they must share one dial, not race).
3. The shell fires `app:active` on resume, so the reconnect starts before the user
   asks. In practice they never see it.
4. The shim's request handler ALSO calls it. That is the path nothing else can
   cover: phone asleep, queue paused, link dead, user presses play on the LOCK
   SCREEN. No UI is awake to help; the loopback request itself has to heal the
   connection.
The trap this exposed: **the shim must survive a reconnect and KEEP ITS PORT.** It
listens on port 0, and the player is holding `http://127.0.0.1:<port>/t/<id>` URLs
for the whole queue. The first version of `reconnect` tore the shim down and built
a new one - a new port - so a paused queue would have resumed into a dead socket.
The shim now takes a replaceable client (`setClient`) instead.
Also: we no longer tell the user their access "may have been revoked" when the
link drops. From the phone, a revoke and an Android suspend look identical, and
that sentence is alarming when the true answer is "you locked your phone". It is
now only said after a reconnect has actually failed.

## 2026-07-14 - Shuffle and repeat are INDEPENDENT, and both may be on
Tier: T1 (UI)
Context: Tim noticed both can be enabled at once on an album and asked whether
that is expected. It is - this is a NOTE, not a bug, and it is written down so
nobody "fixes" it later.
Choice: they stay orthogonal. Confirmed with Tim 2026-07-14.
Why: they answer different questions. Shuffle decides the ORDER; repeat decides
what happens at the END. Every mainstream player (Spotify, Apple Music, YouTube
Music) allows the combination, and shuffle + repeat-all - shuffle the album and
loop it forever - is one of the most common ways people actually listen. Making
them exclusive would also mean fighting the platform: ExoPlayer exposes
`shuffleModeEnabled` and `repeatMode` as two independent properties, so we would
be writing code to take a feature away.
The four states, all coherent:
  shuffle off + repeat off -> album in order, stops at the end
  shuffle on  + repeat off -> album shuffled, stops at the end
  shuffle on  + repeat all -> shuffled, loops forever
  shuffle on  + repeat one -> loops this track; shuffle picks what comes next
                              whenever the listener does skip

## 2026-07-14 - The theme preference lives in the WORKLET, not localStorage
Tier: T1 (local state)
Context: every sibling app (PearPetal, PearList, PearCircle) keeps the theme
preference in the WebView's localStorage and reads it synchronously in main.jsx
before the first paint.
Choice: PearTune keeps it in the worklet, in `settings.json`, next to the device
identity and the paired host. A deliberate deviation from the suite.
Why: it is the only way to get a FLASH-FREE cold start here. The shell boots the
worklet BEFORE it loads the WebView, so it can read the preference, resolve
'system' against `Appearance`, paint its own chrome (status bar + the strip under
the WebView) correctly, and hand the WebView a document that already carries the
right `data-theme`. With localStorage the shell cannot see the preference at all
(it is inside the WebView it has not created yet), which is exactly why PearPetal
needs a separate AsyncStorage cache of the resolved theme to avoid the flash - two
stores for one fact. One store, read once, at the only moment that matters.
Cost: settings are gone if the app's data is cleared - the same wipe that already
takes the device identity and forces a re-pair, so nothing new is at risk.
Verified on the TCL: preference Light, force-stop, relaunch - the FIRST painted
frame (the "Starting…" screen, before the library loads) is already light.

## 2026-07-14 - The navbar stays visible during a drill-down
Tier: T1 (UI)
Context: PearList hides its tab bar when a list is open, treating a drill-down as
a full-screen takeover.
Choice: PearTune keeps the navbar visible inside an album or an artist.
Why: the dock is one fixed object - the player sits ON the navbar. Hiding the
navbar under an album would drop the player ~64px down the screen mid-song, and
raise it again on the way back. A music app's transport does not move.

## 2026-07-14 - Gradle must never cache the JS bundle task
Tier: T1 (build)
Context: PearTune's whole UI is an ASSET (`assets/index.html`, built by esbuild),
not a JS source file - and so is the Bare worklet bundle.
Choice: `outputs.upToDateWhen { false }` on `createBundle*JsAndAssets` in
`android/app/build.gradle`.
Why: gradle's up-to-date check does not notice when only those assets change. It
skips the bundle task, repackages the PREVIOUS bundle, and the APK silently ships
a STALE UI - you rebuild, install, screenshot, and are looking at old code with no
error anywhere. Found the honest way: a CSS fix that would not apply, twice.
Cost: ~30s per debug build. Cheaper than shipping the wrong bundle.

## 2026-07-13 - NOT WebRTC. HyperDHT for transport, loopback HTTP for the player
Tier: T3 (transport)
Context: WebRTC comes up a lot in the Pear/Holepunch space around streaming
media, so: should PearTune use it instead of "HTTP"?
First, a category error worth naming: **the HTTP in PearTune never touches the
network.** The shim runs on 127.0.0.1 between our Bare worklet and Android's
media player - both on the same phone. The phone-to-host transport is already
P2P (HyperDHT + UDX + Noise). So WebRTC would not replace the HTTP; it would
replace HyperDHT.
Choice: keep HyperDHT for transport and the loopback HTTP shim for the player.
Why WebRTC is a downgrade HERE (it is a fine technology, wrong fit):
1. **It reintroduces servers.** WebRTC needs signaling to exchange offers/ICE
   candidates, plus STUN, plus TURN when holepunching fails. TURN is a relay -
   a server you run and pay for, carrying user traffic. "No servers" is the
   whole pitch. Holepunch's DHT does discovery + holepunching with zero infra.
2. **Its media path is the wrong shape.** WebRTC media channels are RTP: built
   for realtime conversation, and they DROP PACKETS to protect latency. Correct
   for a video call, wrong for a FLAC, where we want exact bytes. You would end
   up on DataChannels instead - a reliable ordered byte stream, i.e. exactly
   what UDX already gives us, with more overhead and a signaling dependency.
3. **It would destroy the auth model.** Everything here rests on Noise
   authenticating the far end AS A PUBLIC KEY, which is what lets the host
   allow-list device pubkeys with no bearer token anywhere. WebRTC identity is
   DTLS fingerprints exchanged over whatever signaling you built, so pairing,
   grants and revocation would have to be rebuilt on a weaker foundation.
When WebRTC WOULD be right, and we should revisit then: (a) a BROWSER client -
browsers cannot open raw UDP sockets, so WebRTC is the only P2P transport
available there; (b) genuinely realtime audio (listen-together, broadcast,
calls), which is what RTP is actually for. Neither is v1.
Alternatives to the loopback shim (the real competitor, not WebRTC): a custom
ExoPlayer DataSource in Kotlin reading straight from the worklet - no socket, no
cleartext exemption, less copying. Rejected for now: real native code per
platform plus a Kotlin-to-Bare bridge, to replace a shim that is already proven.
Revisit if on-device profiling shows the HTTP hop actually costs battery or CPU.

## 2026-07-13 - Protomux message order lives in ONE shared file
Tier: T3 (wire format)
Context: Protomux assigns each message a type id by REGISTRATION ORDER - first
`addMessage()` is type 0, next is type 1. Host and client each registered their
own, in different orders (host: `paired` then `deviceHello`; client the reverse).
Both ends decoded every frame as the wrong type. It fails SILENTLY: the frames
arrive, decode into garbage, and the handler you expected simply never fires, so
pairing hung with no error on either side. The media channel had the same latent
mismatch.
Choice: `protocol/channels.js` owns the registration order and both sides build
channels through its factories. Hand-rolling `mux.createChannel` + `addMessage`
for a PearTune channel is now a bug by definition. New message types append to
the END of the list; inserting in the middle silently renumbers the wire.
Consequences: the ordering can no longer drift between host and app, which are
in different runtimes (Node and Bare) and will be updated on different schedules.

## 2026-07-13 - Pairing dials the host by key; there is no rendezvous topic
Tier: T3 (pairing flow - SUPERSEDES §2 of proposal 2026-07-13-wire-protocol)
Context: the proposal copied PearCircle's seeder QR pairing, where phone and host
meet on a Hyperswarm rendezvous topic derived from a one-time `rv`. That did not
survive contact with the code: Hyperswarm creates its OWN HyperDHT server and
listens on its keypair, so a host running both a Hyperswarm (for pairing) and its
own `dht.createServer` (for media) under one identity had two servers fighting
over the same keypair, and deadlocked.
Choice: drop the rendezvous entirely. The QR already carries the host's public
key, so the phone DIALS THE HOST DIRECTLY by key. `rv` survives as a one-time
pairing TOKEN, presented in the hello to prove the device actually saw the QR.
The firewall gains a narrow exemption: while a pairing window is open it admits
an ungranted device, and `_onconnection` then offers it the pair channel ONLY,
never the media API.
Alternatives: give the pairing swarm a separate keypair (then the phone cannot
verify the host against the QR); keep Hyperswarm and drop our own server (loses
the `firewall` hook, which is the entire auth design).
Consequences: STRICTLY STRONGER than what it replaces. Dialing a HyperDHT key
means Noise authenticates the far end AS that key, so an impostor who
photographed the QR cannot answer the call at all. The seeder's "verify the
remote pubkey matches the QR" guard stops being a check we must remember to
write and becomes a property of the transport. Also simpler: no Hyperswarm in
the host at all until the ledger needs one in milestone 3.
Why the seeder differs: there the PHONE held the secrets and the seeder was
anonymous, so a rendezvous was the only way to meet. Here the host has the
stable public identity. Do not cargo-cult the seeder's flow into a third app
without checking which side is anonymous.

## 2026-07-13 - Bitrate adapts to the network, with a user override
Tier: T1 (client policy; the wire already carries the params)
Context: a FLAC library over cellular is roughly 300MB an album and will stutter,
but always transcoding wastes fidelity on the wifi where most listening happens.
Choice: original quality on wifi, capped bitrate on cellular, overridable in
settings. `media.stream` carries `format` / `bitrate`, which the Navidrome
adapter passes straight through to Navidrome's own transcoder.
Alternatives: always-original (burns data), one fixed user setting (wastes
either data or fidelity, since it cannot know the network).
Consequences: free for Navidrome sources. The **folder adapter has no transcoder
to delegate to**, so a raw FLAC library over cellular is the one case that still
costs real data - the client must warn on that combination.

## 2026-07-13 - Revoke is an access control, not a history eraser
Tier: T2 (ledger semantics)
Context: when a device is revoked, do its `count:` play-count rows leave the
ledger with it?
Choice: they stay, and keep contributing to totals. Play history belongs to the
user and should not evaporate because they retired an old phone.
Alternatives: purge on revoke (means removing an Autobase writer, a much bigger
hammer, and it makes revoke irreversibly destructive); purge only for people and
not devices (the ledger would have to know which grants were "you" vs "a guest").
Consequences: a revoked device cannot reach the library, but its historical
contribution to play counts persists. Say so in the revoke UI so it is not a
surprise.

## 2026-07-13 - The host is a full Autobase writer, not a blind seeder
Tier: T3 (trust model)
Context: PearCircle's seeder is deliberately blind - it stores encrypted blocks
it cannot read. Should PearTune's host be the same?
Choice: full writer. It never writes state rows, but it participates in the
ledger so that (a) your resume position is reachable when every phone is off,
and (b) a new device can be admitted as a writer without another phone awake.
Alternatives: blind seeder (cannot admit writers, so pairing a second device
while the first phone is off leaves it stuck read-only); blind seeder plus a
narrow admission side channel (new protocol surface in the most
security-critical part of the design, which is exactly where not to be clever).
Consequences: the host can read listening history. Acceptable: it is a machine
you own that already holds the music in the clear, and listening history is far
less sensitive than the location trail that motivated blind seeding in
PearCircle. This asymmetry is deliberate and must not be cargo-culted back.

## 2026-07-13 - Track ids are source-scoped; a source switch orphans state
Tier: T2 (key derivation)
Context: `trackId = z32(blake2b('peartune/track/1' || libraryId || sourceKey))`,
where sourceKey is the Navidrome id or the library-relative path. So the same
file reached two ways hashes two ways.
Choice: accept it for v1 and warn in the UI **before** a source switch, not
after. A tag-matching remap tool is the escape hatch if it bites.
Alternatives: content-hash the audio (bulletproof, but a full read of a large
FLAC library on a Pi-class Umbrel is slow and disk-punishing); tag-derived ids
(no rescan cost, but they collide on compilations and live albums, and break
when you fix a typo in a tag).
Consequences: switching a library from raw folder to Navidrome loses resume
positions, favorites and play counts. TODO for the remap tool.

## 2026-07-13 - Build our own host on hyperdht; do NOT depend on holesail
Tier: T3 (auth gate + wire protocol)
Context: holesail.io is a P2P TCP/UDP proxy on the same Holepunch stack, and
looked like it might save us the entire host transport.
Choice: build our own host daemon directly on MIT `hyperdht`, using
`dht.createServer({ firewall(remotePublicKey) })` against a host-local
allow-list. Borrow holesail's *shape* (invite encoding, mode header) clean-room,
take none of its code.
Alternatives: depend on / vendor / fork holesail.
Consequences: rejected on two independent grounds, either of which suffices.
(1) **It cannot do what we need.** Its "private" mode admits only a client whose
keypair IS the server's own keypair, derived from a shared seed; its newer
`@holesail/invite` capability is still one bearer token shared by every client.
No per-device identity, and the only revocation is rotating the seed, which
kicks everyone. We require per-device and per-person grant/revoke.
(2) **Licensing.** holesail and `@holesail/*` are AGPL-3.0, holesail-server /
-client are GPL-3.0. The suite is MIT.
The wheel we would be "reinventing" does not exist: what holesail offers is a
shared-password tunnel, and what we need is authorization. Noise already
authenticates every HyperDHT connection, so the host learns the client's real
device pubkey for free and there is no bearer token anywhere in our design.

## 2026-07-13 - Normalized host API, not a raw port tunnel
Tier: T3 (wire protocol)
Context: the cheap path is holesail-style - tunnel Navidrome's port and let the
phone speak HTTP to it.
Choice: the host exposes a normalized `peartune/media/1` API over the
authenticated stream. Two source adapters (Navidrome/Subsonic, raw folder) sit
behind it, and the app cannot tell them apart.
Alternatives: raw port tunnel.
Consequences: a scoped guest never gets handed Navidrome's whole surface and its
credentials; scopes are enforceable per request; and the app never learns to
speak Subsonic, which keeps the raw-folder adapter a first-class citizen instead
of an afterthought. Costs us an API surface we would not otherwise have written.
