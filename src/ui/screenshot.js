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
// NOT YET WIRED: `view` is what each scene SHOULD show, and nothing routes to it yet - every
// scene currently renders whatever the app opens on, which is the library grid. Captured on the
// iOS Simulator 2026-07-30 and all six frames came out identical, which is the exact failure
// TODO.md warns about ("six identical screenshots is worse than none"). The data layer, the scene
// plumbing, the forced appearance and the suppressed spinner all work; routing is the missing
// piece. See TODO.md for what each view needs.
export const SCENES = {
  1: { tab: 'library', view: 'nowplaying', label: 'Now playing' },
  2: { tab: 'library', view: 'albums', label: 'Your library' },
  3: { tab: 'library', view: 'albums', merged: true, label: 'Every library at once' },
  4: { tab: 'library', view: 'pairing', label: 'Pair with a QR code' },
  5: { tab: 'you', view: 'manage', label: 'Who has access' },
  6: { tab: 'you', view: 'downloads', label: 'Offline' }
}

export function activeScene () {
  const n = Number(window.__pearScreenshotScene) || 0
  return SCENES[n] ? { n, ...SCENES[n] } : null
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
  durationMs: 214000,
  art: art(fx, a.coverId),
  artFull: art(fx, a.coverId)
})

// Canned answers, keyed by the worklet method the UI would have called. Anything not listed
// falls through to the real bridge, so an unmocked call still behaves rather than hanging - a
// screen that quietly renders nothing is the failure mode that makes screenshots worthless.
export function fixtureAnswer (scene, method, args) {
  const fx = fixture()
  if (!fx) return undefined
  const albums = fx.albums.map((a) => asAlbum(fx, a))

  switch (method) {
    case 'init':
      return {
        loading: false,
        connected: true,
        host: { libraryName: scene.merged ? 'All libraries' : "Tim's Umbrel", libraryId: 'lib', hostKey: 'k' },
        hosts: scene.merged
          ? [{ libraryId: 'lib', libraryName: "Tim's Umbrel" }, { libraryId: 'lib2', libraryName: "Tim's Mac mini" }]
          : [{ libraryId: 'lib', libraryName: "Tim's Umbrel" }],
        settings: {},
        stats: { albums: albums.length, artists: new Set(fx.albums.map((a) => a.artist)).size }
      }
    case 'albums':
      return { items: albums, cursor: albums.length, total: albums.length }
    case 'artists':
      return {
        items: [...new Set(fx.albums.map((a) => a.artist))].map((n, i) => ({ id: 'ar' + i, name: n, albumCount: 1 }))
      }
    case 'downloads':
      // A believable pinned set rather than the whole library - "I keep some of it offline".
      return albums.slice(0, 8).map((a) => ({ ...a, tracks: [asTrack(fx, fx.albums[0], 0)] }))
    case 'favorites':
      return { track: [], album: albums.slice(0, 5).map((a) => a.id), artist: [], supported: true }
    case 'resumeLatest':
      return null // no "continue listening" card competing with the scene
    default:
      return undefined
  }
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
