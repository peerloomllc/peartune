'use strict'

// The view snapshot is written to settings.json and read back on launch, which makes
// normalizeViewState the app's launch path: a file written by another build, a
// half-written one, or one carrying a screen type this build no longer renders, all
// arrive here first. Get it wrong and the app opens on a blank screen with a navbar,
// which reads as broken rather than stale - so the degrade-to-Library behaviour is
// what these pin, alongside the write-suppression that keeps a scroll from rewriting
// the file every frame.

const test = require('node:test')
const assert = require('node:assert')

const load = () => import('../src/ui/viewstate.js')

test('a snapshot round-trips unchanged', async () => {
  const { normalizeViewState } = await load()
  const v = {
    tab: 'you',
    browse: 'artists',
    youView: 'playlists',
    filter: 'jud4pgi4',
    stack: [{ type: 'artist', id: 'a1', name: 'Bowie' }, { type: 'album', id: 'al1' }],
    expanded: true,
    scroll: 1840
  }
  assert.deepStrictEqual(normalizeViewState(v), v)
})

test('missing or non-object input is no snapshot at all', async () => {
  const { normalizeViewState } = await load()
  for (const bad of [null, undefined, 'library', 42, []]) {
    // An array IS an object, so it normalizes to the defaults rather than null - the
    // point is only that nothing throws and nothing unknown gets through.
    const r = normalizeViewState(bad)
    if (r) assert.strictEqual(r.tab, 'library')
    else assert.strictEqual(r, null)
  }
})

test('an unknown tab, browse or sub-view falls back rather than rendering nothing', async () => {
  const { normalizeViewState } = await load()
  const r = normalizeViewState({ tab: 'radio', browse: 'podcasts', youView: 'inbox' })
  assert.strictEqual(r.tab, 'library')
  assert.strictEqual(r.browse, 'albums')
  assert.strictEqual(r.youView, 'favorites')
})

test('unknown screen types and id-less entries are dropped from the stack', async () => {
  const { normalizeViewState } = await load()
  const r = normalizeViewState({
    stack: [
      { type: 'album', id: 'ok' },
      { type: 'podcast', id: 'x' }, // a type this build does not render
      { type: 'artist' }, // no id: the screen would fetch undefined
      { type: 'artist', id: '' },
      'nonsense',
      null
    ]
  })
  assert.deepStrictEqual(r.stack, [{ type: 'album', id: 'ok' }])
})

test('the stack is capped, so a runaway file cannot become a runaway write', async () => {
  const { normalizeViewState } = await load()
  const deep = Array.from({ length: 40 }, (_, i) => ({ type: 'album', id: 'a' + i }))
  assert.strictEqual(normalizeViewState({ stack: deep }).stack.length, 8)
})

test('a numeric id survives as a number', async () => {
  const { normalizeViewState } = await load()
  // Ids are source-scoped hashes today, but an adapter handing back numbers must not
  // have them silently stringified into an id that fetches nothing.
  assert.deepStrictEqual(normalizeViewState({ stack: [{ type: 'album', id: 7 }] }).stack, [{ type: 'album', id: 7 }])
})

test('the server flag rides only on playlists', async () => {
  const { normalizeViewState } = await load()
  const r = normalizeViewState({
    stack: [{ type: 'playlist', id: 'p', server: true }, { type: 'album', id: 'a', server: true }]
  })
  assert.strictEqual(r.stack[0].server, true)
  assert.strictEqual('server' in r.stack[1], false)
})

test('fields nobody restores are dropped rather than carried', async () => {
  const { normalizeViewState } = await load()
  const r = normalizeViewState({ tab: 'library', junk: 'x', stack: [{ type: 'album', id: 'a', junk: 1 }] })
  assert.strictEqual('junk' in r, false)
  assert.strictEqual('junk' in r.stack[0], false)
})

test('a nonsense scroll offset is not a position', async () => {
  const { normalizeViewState } = await load()
  assert.strictEqual(normalizeViewState({ scroll: -40 }).scroll, 0)
  assert.strictEqual(normalizeViewState({ scroll: NaN }).scroll, 0)
  assert.strictEqual(normalizeViewState({ scroll: 'far' }).scroll, 0)
  assert.strictEqual(normalizeViewState({ scroll: 1e12 }).scroll, 200000)
  assert.strictEqual(normalizeViewState({ scroll: 12.7 }).scroll, 13)
})

test('expanded is only ever a literal true', async () => {
  const { normalizeViewState } = await load()
  assert.strictEqual(normalizeViewState({ expanded: 'yes' }).expanded, false)
  assert.strictEqual(normalizeViewState({ expanded: 1 }).expanded, false)
  assert.strictEqual(normalizeViewState({ expanded: true }).expanded, true)
})

test('a device that never left the Library root has nothing to restore', async () => {
  const { isDefaultView } = await load()
  assert.strictEqual(isDefaultView(null), true)
  assert.strictEqual(isDefaultView({}), true)
  assert.strictEqual(isDefaultView({ tab: 'library', browse: 'albums', scroll: 0 }), true)
  // A remembered sub-view is NOT on its own worth a restore: the You tab is not open.
  assert.strictEqual(isDefaultView({ tab: 'library', youView: 'playlists' }), true)
})

test('any real position counts as something to restore', async () => {
  const { isDefaultView } = await load()
  assert.strictEqual(isDefaultView({ tab: 'settings' }), false)
  assert.strictEqual(isDefaultView({ browse: 'songs' }), false)
  assert.strictEqual(isDefaultView({ scroll: 400 }), false)
  assert.strictEqual(isDefaultView({ expanded: true }), false)
  assert.strictEqual(isDefaultView({ filter: 'jud4pgi4' }), false)
  assert.strictEqual(isDefaultView({ stack: [{ type: 'album', id: 'a' }] }), false)
})

test('an unchanged snapshot is not a write', async () => {
  const { normalizeViewState, sameViewState } = await load()
  const a = normalizeViewState({ tab: 'you', scroll: 100 })
  const b = normalizeViewState({ tab: 'you', scroll: 100 })
  assert.strictEqual(sameViewState(a, b), true)
  assert.strictEqual(sameViewState(a, normalizeViewState({ tab: 'you', scroll: 101 })), false)
  assert.strictEqual(sameViewState(null, a), false)
  assert.strictEqual(sameViewState(null, null), true)
})
