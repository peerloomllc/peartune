// Store-screenshot scenes: the fixture layer (src/ui/screenshot.js).
//
// The property that matters most is the NEGATIVE one - an ordinary launch must be completely
// untouched. Everything else here is cosmetic; that one is the difference between a screenshot
// harness and a bug that shows people a library they do not have.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

// The module is an ESM source consumed by esbuild, so load it the same way the bundle does.
const load = async () => import(path.join(__dirname, '..', 'src/ui/screenshot.js'))

// AWAITS fn. An earlier version returned fn() and restored the globals in `finally`, which for
// an async body tore `window` down while the assertions were still running - the test failed with
// "window is not defined" and the code was fine.
async function withGlobals (scene, fx, fn) {
  const g = globalThis
  const hadWindow = 'window' in g
  const prev = hadWindow ? g.window : undefined
  g.window = { __pearScreenshotScene: scene, __pearScreenshotFixture: fx }
  try { return await fn() } finally { if (hadWindow) g.window = prev; else delete g.window }
}

const FX = {
  albums: [
    { id: 'a1', name: '66 MHz', artist: 'Waveshaper', year: 2017, coverId: 'c1' },
    { id: 'a2', name: '09/17 2007 - EP', artist: 'Danger', year: 2010, coverId: 'c2' },
    { id: 'a3', name: 'Nightdrive', artist: 'ALEX', year: 2015, coverId: 'c3' }
  ],
  covers: { c1: 'data:image/jpeg;base64,AAA', c2: 'data:image/jpeg;base64,BBB' }
}

test('NO SCENE means the bridge is handed back completely unchanged', async () => {
  const { wrapCall, activeScene } = await load()
  await withGlobals(undefined, undefined, () => {
    const real = () => Promise.resolve('real')
    assert.equal(wrapCall(real), real, 'wrapCall must return the SAME function, not a wrapper')
    assert.equal(activeScene(), null)
  })
})

test('an unknown scene number is not a scene', async () => {
  const { activeScene } = await load()
  await withGlobals(99, FX, () => assert.equal(activeScene(), null))
  await withGlobals(0, FX, () => assert.equal(activeScene(), null))
})

test('every scene in the slate maps to a screen, and the order is the store order', async () => {
  const { SCENES } = await load()
  assert.deepEqual(Object.keys(SCENES), ['1', '2', '3', '4', '5', '6'])
  // Slot 1 is what a store browser judges in about a second - it must be the music, not a
  // settings page. Changing this is a product decision, not a refactor.
  assert.equal(SCENES[1].view, 'nowplaying')
  assert.equal(SCENES[2].view, 'albums')
  assert.equal(SCENES[3].merged, true, 'scene 3 is the point of multi-library')
})

test('a scene answers browse calls from the fixture, with artwork attached', async () => {
  const { fixtureAnswer, activeScene } = await load()
  await withGlobals(2, FX, () => {
    const scene = activeScene()
    const albums = fixtureAnswer(scene, 'albums', {})
    assert.equal(albums.items.length, 3)
    assert.equal(albums.items[0].name, '66 MHz')
    assert.equal(albums.items[0].art, 'data:image/jpeg;base64,AAA', 'artwork comes from the fixture, not a shim')
    // An album whose cover was not captured must render as artless rather than as a broken URL.
    assert.equal(albums.items[2].art, null)
  })
})

test('an UNMOCKED method falls through instead of hanging', async () => {
  // A screen that quietly renders nothing is the failure mode that makes a screenshot worthless,
  // and it is exactly what returning a canned undefined would cause.
  const { wrapCall } = await load()
  await withGlobals(2, FX, async () => {
    const wrapped = wrapCall((m) => Promise.resolve('real:' + m))
    assert.equal(await wrapped('somethingNobodyMocked'), 'real:somethingNobodyMocked')
    assert.equal((await wrapped('albums')).items.length, 3)
  })
})

test('with a scene but NO fixture, everything falls through to the real bridge', async () => {
  // The fixture is never bundled - it is injected. A build without one must degrade to the real
  // app rather than to empty screens.
  const { wrapCall } = await load()
  await withGlobals(2, undefined, async () => {
    const wrapped = wrapCall((m) => Promise.resolve('real:' + m))
    assert.equal(await wrapped('albums'), 'real:albums')
  })
})

// --- routing -----------------------------------------------------------------
//
// THE FAILURE THESE EXIST TO CATCH: the first cut of this file declared what each scene should
// show and nothing acted on it, so all six frames came out as the library grid - and every check
// still passed, because a scene that renders the wrong screen renders a perfectly good screen.
// Each test below is written to fail if the routing quietly did nothing.

test("every scene's restore snapshot survives the app's own view validator", async () => {
  // A scene reaches its screen by handing init a `settings.view`, which the app runs through
  // normalizeViewState before acting on it. A typo'd tab or an unlisted youView is not an error
  // there: it is silently rewritten to the library root, which is exactly the identical-frames
  // bug. So assert on what the app will actually DO with each snapshot, not on what we wrote.
  const { SCENES } = await load()
  const { normalizeViewState, isDefaultView } = await import(path.join(__dirname, '..', 'src/ui/viewstate.js'))
  for (const [n, s] of Object.entries(SCENES)) {
    if (!s.restore) continue
    const v = normalizeViewState(s.restore)
    assert.deepEqual(
      { tab: v.tab, youView: v.youView, expanded: v.expanded },
      { tab: s.restore.tab, youView: s.restore.youView ?? v.youView, expanded: s.restore.expanded === true },
      `scene ${n} is rewritten by normalizeViewState - it would open on the library root`
    )
    assert.equal(isDefaultView(v), false, `scene ${n} restores to the default view, so restoreView skips it entirely`)
  }
})

test('the scenes do not all land on the same screen', async () => {
  // The one-line statement of the bug. Six scenes, at least four distinct destinations.
  const { SCENES } = await load()
  const where = Object.values(SCENES).map(s => JSON.stringify([s.restore || null, s.opens || null]))
  assert.ok(new Set(where).size >= 4, 'scenes collapse onto the same screen: ' + where.join(' '))
})

test('init hands back the scene view AND suppresses the owner tour', async () => {
  const { fixtureAnswer, SCENES } = await load()
  await withGlobals(6, FX, () => {
    const s = fixtureAnswer({ n: 6, ...SCENES[6] }, 'init', {})
    assert.deepEqual(s.settings.view, { tab: 'you', youView: 'downloads' })
    // The first-time-owner explainer is a modal, and scenes 4 and 5 are the owner screens it
    // would open over. It is gated on this flag.
    assert.equal(s.settings.ownerTourShown, true)
  })
})

test('Downloads answers the shape the screen reads', async () => {
  // App.jsx does `(await call('downloads')).items` - an array here reads as zero downloads and
  // paints the "No downloads yet" empty state, in the frame captioned "Offline".
  const { fixtureAnswer, SCENES } = await load()
  await withGlobals(6, FX, () => {
    const d = fixtureAnswer({ n: 6, ...SCENES[6] }, 'downloads', {})
    assert.ok(Array.isArray(d.items) && d.items.length > 0)
    assert.ok(d.items[0].name && d.items[0].art !== undefined)
  })
})

test('the Recently Added shelf gets albums recent enough to survive its own filter', async () => {
  // The shelf keeps only albums added in the last 7 days (recentEnough, App.jsx) and is gated on
  // the host advertising the 'added' sort (stats). Miss either and it renders nothing at all.
  const { fixtureAnswer, SCENES } = await load()
  await withGlobals(2, FX, () => {
    const scene = { n: 2, ...SCENES[2] }
    assert.ok(fixtureAnswer(scene, 'stats', {}).sorts.albums.keys.includes('added'))
    const page = fixtureAnswer(scene, 'albums', { sort: 'added', order: 'desc', limit: 12 })
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000
    assert.ok(page.items.length > 0)
    assert.ok(page.items.every(a => Number(a.addedAt) > cutoff), 'stamped too old - the shelf filters them all out')
  })
})

test('the Manage roster names THIS phone as the owner', async () => {
  // ManageBody matches d.deviceKey against the deviceKey init handed over. Get that wrong and the
  // owner row loses its "this phone" badge and grows a revoke button - a frame showing the app
  // offering to revoke itself.
  const { fixtureAnswer, SCENES } = await load()
  await withGlobals(5, FX, () => {
    const scene = { n: 5, ...SCENES[5] }
    const self = fixtureAnswer(scene, 'init', {}).deviceKeyZ32
    const { devices } = fixtureAnswer(scene, 'ownerDevices', {})
    assert.ok(devices.length >= 3, 'a one-row roster does not show what the screen is for')
    const me = devices.find(d => d.deviceKey === self)
    assert.ok(me, 'no device row matches this device')
    assert.equal(me.scope, 'owner')
    assert.ok(devices.some(d => d.scope !== 'owner'), 'nobody to revoke = nothing to show')
    assert.ok(devices.every(d => !d.revokedAt))
  })
})

test('the pairing QR encodes a link the app would actually accept', async () => {
  // The QR is the whole of scene 4. A made-up string would still render a tidy QR code, so parse
  // it with the real parser rather than eyeballing the frame.
  const { fixtureAnswer, SCENES } = await load()
  const { parseLink, isPairLink } = require('../protocol/link')
  await withGlobals(4, FX, () => {
    const r = fixtureAnswer({ n: 4, ...SCENES[4] }, 'ownerPairStart', {})
    assert.equal(r.ok, true)
    assert.ok(isPairLink(r.link))
    const parsed = parseLink(r.link)
    assert.equal(parsed.version, 1)
    assert.equal(parsed.rv.length, 32)
    assert.equal(parsed.hostKey.length, 32)
  })
})

test('runScene starts the player for scene 1 and opens the pairing sheet for scene 4', async () => {
  const { runScene } = await load()
  const seen = []
  const g = globalThis
  const hadWindow = 'window' in g
  const prev = hadWindow ? g.window : undefined
  try {
    // Scene 1: the player is driven by the SAME events the shell sends, so the UI cannot tell
    // the difference. No event, no `now`, and the full-size player never mounts.
    g.window = { __pearScreenshotScene: 1, __pearScreenshotFixture: FX, __pearEvent: (n, d) => seen.push([n, d]) }
    let paired = 0
    runScene({ openOwnerPair: () => paired++ })
    assert.deepEqual(seen.map(e => e[0]), ['play:started', 'play:status'])
    assert.ok(seen[0][1].title, 'the track has to carry a title - it is the biggest text in the frame')
    assert.ok(seen[0][1].art, 'and its artwork')
    assert.equal(seen[1][1].playing, true)
    assert.equal(paired, 0)

    // Scene 4: the sheet, and no phantom playback behind it.
    seen.length = 0
    g.window = { __pearScreenshotScene: 4, __pearScreenshotFixture: FX, __pearEvent: (n, d) => seen.push([n, d]) }
    runScene({ openOwnerPair: () => paired++ })
    assert.equal(paired, 1)
    assert.deepEqual(seen, [])

    // And NO scene: the launch every real user makes.
    seen.length = 0
    g.window = { __pearEvent: (n, d) => seen.push([n, d]) }
    runScene({ openOwnerPair: () => paired++ })
    assert.equal(paired, 1, 'runScene acted without a scene')
    assert.deepEqual(seen, [])
  } finally {
    if (hadWindow) g.window = prev; else delete g.window
  }
})

test('sceneOpens is false for every screen on an ordinary launch', async () => {
  const { sceneOpens } = await load()
  await withGlobals(undefined, undefined, () => {
    assert.equal(sceneOpens('libraryMenu'), false)
    assert.equal(sceneOpens('ownerPair'), false)
  })
  await withGlobals(3, FX, () => {
    assert.equal(sceneOpens('libraryMenu'), true)
    assert.equal(sceneOpens('ownerPair'), false)
  })
})

test('scene 3 says two libraries, scene 2 says one', async () => {
  const { fixtureAnswer, SCENES } = await load()
  await withGlobals(3, FX, () => {
    const s3 = fixtureAnswer({ n: 3, ...SCENES[3] }, 'init', {})
    assert.equal(s3.hosts.length, 2)
    assert.equal(s3.host.libraryName, 'All libraries')
    const s2 = fixtureAnswer({ n: 2, ...SCENES[2] }, 'init', {})
    assert.equal(s2.hosts.length, 1)
  })
})
