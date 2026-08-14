// Store-screenshot scenes: the UI half.
//
// The shell injects `window.__pearScreenshotScene` (1-6) from the launch intent before this
// bundle runs - see plugins/with-screenshot-scene.js. When it is set, we swap the bridge for
// canned answers so the six frames show six different screens instead of six cold starts.
//
// WHY INTERCEPT THE BRIDGE rather than teach the screens about scenes: no screen has to know
// this exists, so a scene cannot drift from the real UI. What is captured IS the shipping
// interface, rendering real data that came out of a real library (metadata/screenshot-fixtures,
// see scripts/screenshot-fixture.sh) - only the transport is faked. PearGuard does the same by
// swapping window.callBare.
//
// THE DATA IS NOT BUNDLED. It is injected as `window.__pearScreenshotFixture` beside the scene
// number, because the covers are real commercial album art from Tim's own library: fine in a
// store listing he publishes, not fine committed to a public repo. Nothing here ships with the
// app; without an injected fixture every scene falls back to whatever the app really has.

// Which screen each scene is. The ORDER is the store listing's order and was chosen
// deliberately (TODO.md, 2026-07-30): open looking like a good music player, THEN earn the
// differentiator, because a store browser judges the first frame in about a second.
//
// HOW A SCENE REACHES ITS SCREEN. Almost entirely as DATA: `restore` below is handed to the UI
// as `settings.view` in the canned init answer, and the app already puts itself back on that
// screen on every launch (src/ui/viewstate.js) - so a scene arrives by the same path a relaunch
// does and no screen has to be taught that scenes exist. `opens` is the remainder: two things
// (the full-size player, the pairing sheet) are local component state with no data path into
// them, and runScene() drives those from App.jsx's one guarded read. See TODO.md.
export const SCENES = {
  1: { tab: 'library', view: 'nowplaying', label: 'Now playing', restore: { tab: 'library', browse: 'albums', expanded: true }, opens: 'player' },
  2: { tab: 'library', view: 'albums', label: 'Your library' },
  3: { tab: 'library', view: 'albums', merged: true, label: 'Every library at once', opens: 'libraryMenu' },
  4: { tab: 'you', view: 'pairing', label: 'Pair with a QR code', restore: { tab: 'you', youView: 'manage' }, opens: 'ownerPair' },
  5: { tab: 'you', view: 'manage', label: 'Who has access', restore: { tab: 'you', youView: 'manage' } },
  6: { tab: 'you', view: 'downloads', label: 'Offline', restore: { tab: 'you', youView: 'downloads' } }
}

export function activeScene () {
  const n = Number(window.__pearScreenshotScene) || 0
  return SCENES[n] ? { n, ...SCENES[n] } : null
}

// Does the active scene need this local-state screen opened? The ONE question App.jsx (and the
// library header) asks, so a screen never carries a scene number around. Always false on an
// ordinary launch, because there is no scene at all.
export function sceneOpens (what) {
  const scene = activeScene()
  return !!scene && scene.opens === what
}

// The fixture as captured, or null. `albums` carry { id, name, artist, year, coverId } and
// `covers` maps coverId -> a data: URL, so the WebView needs no host and no loopback shim.
function fixture () {
  const f = window.__pearScreenshotFixture
  return f && Array.isArray(f.albums) ? f : null
}

const art = (fx, coverId) => (coverId && fx.covers && fx.covers[coverId]) || null

// Shape a captured album the way the real `albums` RPC does, so the grid cannot tell them apart.
const asAlbum = (fx, a) => ({
  id: a.id,
  name: a.name,
  artist: a.artist,
  year: a.year,
  songCount: a.songCount || 1,
  coverId: a.coverId,
  art: art(fx, a.coverId),
  artFull: art(fx, a.coverId)
})

// One track per album is enough for every scene here: the queue and now-playing screens show a
// title, an artist and artwork, and none of the six is a track listing.
const asTrack = (fx, a, i) => ({
  id: a.id + ':t' + i,
  title: a.name,
  artist: a.artist,
  album: a.name,
  durationMs: TRACK_MS,
  art: art(fx, a.coverId),
  artFull: art(fx, a.coverId)
})

// --- the invented half -------------------------------------------------------
//
// The music above is real; the PEOPLE and the keys below cannot be. A device roster and a pairing
// link have to look exactly like the real thing (the same z32 shape the dashboard prints, a link
// the QR encoder is happy with) while belonging to nobody - so these are synthetic constants, not
// a capture of anyone's actual library. Fixed rather than generated: the same six frames every
// run is what makes two captures comparable.

const SELF_KEY = 'g45c4gahad6qx1xnb87b7ka1sxc1sx399rkhaj6hk7e5mztyb5oy'
// The same capture runs on both platforms, and the roster names THIS phone - so an iPhone frame
// captioned "who has access" must not open with a row called "Pixel 9". The other phone in the
// list becomes the opposite kind, which is the point being made anyway: one library, both stores.
const ios = () => window.__pearPlatform === 'ios'
const selfName = () => (ios() ? 'iPhone 16' : 'Pixel 9')
// The roster for scene 5. The owner row is THIS phone (its key is the one init hands back as
// deviceKeyZ32), so the frame shows the "owner" and "this phone" badges the real screen shows -
// and the other rows carry the revoke control, which is the whole point of that screen.
const devices = () => [
  { deviceKey: SELF_KEY, label: selfName(), scope: 'owner', online: true, belongsTo: 'You' },
  { deviceKey: 'rsg8k84sy5qiqc8eytdozmdmta84x3o7fo9njrdsp9ei9is59bpu', label: ios() ? 'Pixel 9' : 'iPhone 16', scope: 'guest', online: true, belongsTo: 'Sam' },
  { deviceKey: 'uikrpnxk1c8ctsu6sympnucdzpwiiu1p6t5c1i66ztgittbx6iop', label: 'iPad', scope: 'guest', online: false, belongsTo: 'Mum' },
  { deviceKey: '6qdfzu8ktcm6eug7ez4bh5qfo9njrdspa87mj8qhn49w3fiiu13r', label: 'Kitchen tablet', scope: 'guest', online: true, belongsTo: 'You' }
]
// Well-formed but dead: it parses as a pairing link and encodes cleanly into the QR, and pairing
// with it would simply find no such host.
const PAIR_LINK = 'pear://peartune/pair?v=1' +
  '&rv=mkq8tzzhnwobdb3sw615im5ogewi8it7wstdkgk6jduayu8pn9e9' +
  '&host=ir4ezoxke5igmx7ai8g5zhfwyu8mbgucui53ik5q56bn6afi5sgh'

// The library names in the frames. Deliberately generic (Tim, 2026-07-30): these go out on two
// store listings, and a screen captioned with somebody's name reads as one person's setup rather
// than as what anyone gets. The second one is a different KIND of machine on purpose - the whole
// claim of scene 3 is that a blend spans them.
const LIB = { id: 'lib', name: 'My Umbrel Home' }
const LIB2 = { id: 'lib2', name: 'Office Mac' }

const TRACK_MS = 214000
// Where the hero track sits in its own runtime. A third of the way in: far enough that the
// progress bar and the elapsed time both read as PLAYING rather than as a track just tapped.
const TRACK_POS_MS = 78000
// Which album is playing in scene 1. A fixed index rather than a title, so re-packing the fixture
// from another genre still produces a scene; the sixth is far enough in to skip a fixture's
// alphabetical head, which tends to be the numeric titles. It must have ARTWORK, though - a hero
// frame whose cover is the empty-note placeholder is the worst of the six to lose - so a
// coverless pick falls back to the first album that has one.
const HERO = 5
function heroIndex (fx) {
  const has = (i) => fx.albums[i] && art(fx, fx.albums[i].coverId)
  if (has(HERO)) return HERO
  const i = fx.albums.findIndex((a) => art(fx, a.coverId))
  return i >= 0 ? i : 0
}

// Canned answers, keyed by the worklet method the UI would have called. Anything not listed
// falls through to the real bridge, so an unmocked call still behaves rather than hanging - a
// screen that quietly renders nothing is the failure mode that makes screenshots worthless.
export function fixtureAnswer (scene, method, args) {
  const fx = fixture()
  if (!fx) return undefined
  const albums = fx.albums.map((a) => asAlbum(fx, a))
  // A believable pinned set rather than the whole library - "I keep some of it offline".
  const offline = albums.slice(0, 8)

  switch (method) {
    case 'init':
      return {
        loading: false,
        connected: true,
        deviceKeyZ32: SELF_KEY,
        host: { libraryName: scene.merged ? 'All libraries' : LIB.name, libraryId: LIB.id, hostKey: 'k' },
        hosts: scene.merged
          ? [{ libraryId: LIB.id, libraryName: LIB.name, active: true }, { libraryId: LIB2.id, libraryName: LIB2.name }]
          : [{ libraryId: LIB.id, libraryName: LIB.name, active: true }],
        // Two libraries means the app is in MERGED mode, which is what scene 3 is about: the
        // header becomes a switcher over the blend rather than one library's name.
        merged: scene.merged
          ? {
              merged: true,
              libraries: [
                { libraryId: LIB.id, libraryName: LIB.name, connected: true, trackCount: 1358 },
                { libraryId: LIB2.id, libraryName: LIB2.name, connected: true, trackCount: 412 }
              ],
              counts: { artists: new Set(fx.albums.map((a) => a.artist)).size, albums: albums.length, tracks: 1770, genres: 24 }
            }
          : null,
        // WHERE THE SCENE STARTS. `view` is the snapshot the app restores on every launch, so
        // handing one back here is what puts a scene on its own screen - no scene-aware routing
        // anywhere in the app. ownerTourShown matters as much: without it the first-time owner
        // explainer would open over scenes 4 and 5, which are exactly the owner screens.
        settings: { view: scene.restore || null, ownerTourShown: true },
        stats: { albums: albums.length, artists: new Set(fx.albums.map((a) => a.artist)).size }
      }
    case 'albums': {
      // The Recently Added shelf asks this same method with sort:'added' and then keeps only
      // albums added in the last week (recentEnough, App.jsx). Without a stamp the shelf comes
      // back empty and silently does not render, so the top of the library screen goes missing.
      if (args && args.sort === 'added') {
        const n = Math.min(Number(args.limit) || 12, albums.length)
        const now = Date.now()
        return {
          items: albums.slice(0, n).map((a, i) => ({ ...a, addedAt: now - (i + 1) * 6 * 3600 * 1000 })),
          nextCursor: null,
          total: n
        }
      }
      return { items: albums, nextCursor: null, total: albums.length }
    }
    // Merged mode's own recently-added shelf. Same albums; only the route differs.
    case 'recentMerged':
      return { items: albums.slice(0, 12).map((a, i) => ({ ...a, addedAt: Date.now() - (i + 1) * 6 * 3600 * 1000 })) }
    case 'artists':
      return {
        items: [...new Set(fx.albums.map((a) => a.artist))].map((n, i) => ({ id: 'ar' + i, name: n, albumCount: 1 }))
      }
    // Which album sorts the source can do - the Recently Added shelf is gated on 'added' being
    // among them, so an unanswered stats call hides the shelf however well it is stamped.
    case 'stats':
      return {
        source: 'subsonic',
        sourceName: 'Navidrome',
        sorts: { albums: { keys: ['name', 'added', 'year', 'artist'] }, artists: { keys: ['name'] }, tracks: { keys: ['title'] } }
      }
    case 'downloads':
      // NO track count unless the fixture actually carries one. A genre listing answers with
      // songCount 1 for everything (it is not what that endpoint counts), and the Downloads tile
      // prints it verbatim - eight albums each captioned "1 track", in a store screenshot. The
      // tile drops the count when it is absent, so saying nothing is both honest and tidier.
      return { items: offline.map((a) => ({ ...a, count: a.songCount > 1 ? a.songCount : 0, complete: true })) }
    case 'pinnedAlbums':
      return { ids: offline.map((a) => a.id) }
    case 'favorites':
      return { track: [], album: albums.slice(0, 5).map((a) => a.id), artist: [], supported: true }
    case 'resumeLatest':
      return null // no "continue listening" card competing with the scene
    // A capture device may carry a real paused queue from an earlier run, and restoring it would
    // emit a play:started that overwrites scene 1's track with whatever was last played.
    case 'restore':
      return { restored: false }
    // The app persists the tab and scroll it is on. A capture must not write that through to the
    // device's real settings.json, so swallow it.
    case 'setSettings':
      return {}
    case 'identity':
      return {
        deviceName: selfName(),
        userName: 'You',
        confirmed: true,
        belongsTo: 'You',
        libraryName: LIB.name,
        expiresAt: null,
        // Owner unlocks the Manage screen (scene 5) and the pairing window (scene 4).
        owner: true,
        supported: true
      }
    case 'ownedLibraries':
      return { libraries: [{ libraryId: LIB.id, libraryName: LIB.name, active: true }] }
    case 'ownerDevices':
      return { devices: devices(), supported: true }
    // An empty queue on purpose: scene 5 is about WHO HAS ACCESS, and a stack of pending music
    // requests above the roster would take the screen over and tell a different story.
    case 'ownerRequests':
      return { requests: [], supported: true }
    case 'ownerPairStart':
      return { ok: true, link: PAIR_LINK, expiresMs: 5 * 60 * 1000 }
    case 'ownerPairStop':
      return { ok: true }
    default:
      return undefined
  }
}

// The two things a scene cannot express as data: the full-size player only exists once a track is
// PLAYING (which arrives as an event, not as state), and the pairing sheet is local state inside
// App.jsx. Called once, from App's single guarded read, after init has landed.
export function runScene ({ openOwnerPair, openPlayer }) {
  const scene = activeScene()
  if (!scene) return
  const fx = fixture()
  // The bridge's own event dispatcher (bridge.js installs it on window), i.e. exactly the door
  // the shell pushes through - so the UI cannot tell a scene's events from a real player's.
  const emit = (name, data) => { if (typeof window.__pearEvent === 'function') window.__pearEvent(name, data) }

  if (scene.opens === 'player' && fx && fx.albums.length) {
    // OPEN IT FROM HERE, not from a useState initialiser in App.jsx. The player is "local
    // component state with no data path into it" (see the note on SCENES), and the obvious
    // reading of that - `useState(() => sceneOpens('player'))`, the way libMenuOpen does it -
    // DOES NOT WORK: that initialiser runs on App's first render and the scene number is not on
    // window yet, so it reads false. libMenuOpen gets away with it only because its component
    // mounts later. runScene is called from an effect once init has resolved, which is exactly
    // when the scene IS known - the same reason the emits below land. Scene 1 shot the mini
    // player four times before this was understood (2026-08-12).
    if (openPlayer) openPlayer()
    // A FIXTURE MAY CARRY ITS OWN HERO, and when it does that album is deliberately NOT in
    // `albums` - so it never reaches a grid. The synthetic fixture uses this to put REAL cover
    // art in the one frame where a cover fills the screen while the browse grids stay a single
    // coherent invented label; mixing bold real sleeves into forty muted generated ones reads
    // as a mistake rather than as variety. See scripts/make-screenshot-fixture.js.
    const i = heroIndex(fx)
    const t = fx.hero
      ? { ...asTrack(fx, fx.hero.album, 0), ...fx.hero.track, art: art(fx, fx.hero.album.coverId), artFull: art(fx, fx.hero.album.coverId), album: fx.hero.album.name }
      : asTrack(fx, fx.albums[i], 0)
    // The same two messages the shell sends when playback really starts (app/index.tsx
    // announceToUi + pushStatus), so the player renders from its own live state.
    emit('play:started', {
      trackId: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      art: t.art,
      artFull: t.artFull,
      index: i,
      queueLength: fx.albums.length
    })
    emit('play:status', {
      playing: true,
      positionMs: TRACK_POS_MS,
      durationMs: TRACK_MS,
      buffering: false,
      index: i,
      queueLength: fx.albums.length
    })
  }

  if (scene.opens === 'ownerPair') openOwnerPair()
}

// Wrap the real call(). Returns the wrapped function; bridge.js owns the actual swap so the
// import graph stays one-way.
export function wrapCall (realCall) {
  const scene = activeScene()
  if (!scene) return realCall
  return (method, args = {}) => {
    const canned = fixtureAnswer(scene, method, args)
    if (canned !== undefined) return Promise.resolve(canned)
    return realCall(method, args)
  }
}
