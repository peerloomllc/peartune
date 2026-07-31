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
