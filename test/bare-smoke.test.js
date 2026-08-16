// A SMOKE TEST FOR THE WORKLET ITSELF (src/bare.js).
//
// WHY THIS EXISTS. src/bare.js only loads under Bare, so for most of this project's life the
// entire suite could be green while the worklet did not evaluate at all. That is not
// hypothetical: a missed call site after a rename (`ensureAll` still calling `ensureHost`)
// shipped to a phone and surfaced only as `init:merged-rebuild-failed {"err":"ensureHost is not
// defined"}` in logcat - a device round-trip to learn something a `require()` would have said
// instantly. Two more runtime-path bugs in the same file cost device round-trips on 2026-07-28.
//
// WHAT IT COVERS, in increasing order of usefulness:
//   1. the module graph evaluates - every require resolves and no top-level reference is undefined
//   2. the IPC dispatcher answers - so a broken call site inside a METHOD is caught, not just at
//      module scope, which is where the ensureHost bug actually lived
//   3. the whole DEMO library works end to end - browse, search and URL minting, with no host, no
//      network and no device. Demo mode is the one part of the app that is entirely local, which
//      makes it the one part fully testable here.
//
// HOW IT RUNS UNDER NODE. Three stubs and nothing else:
//   - `Bare` / `BareKit`, the two globals the worklet expects
//   - bare-fs / bare-path -> node's fs / path (same API; worklet/cache.js already switches on
//     this at runtime, so it is the project's own convention rather than a trick invented here)
//   - bare-http1 -> a fake server. The shim only ever needs listen/address/close from it, and
//     what is under test is the worklet's logic, not an HTTP implementation.
//
// WHAT IT DELIBERATELY DOES NOT COVER: anything needing a host, the network, or the real native
// addons. Those still need a device, and this test is not a substitute for the verify gate.

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const os = require('os')
const path = require('path')
const fs = require('fs')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-bare-smoke-'))
const DEMO_DIR = path.join(__dirname, '..', 'assets', 'demo-music')

// --- the stubs --------------------------------------------------------------

const sent = [] // every line the worklet has written to IPC
let onData = null // the worklet's own dispatcher, captured so tests can call methods

global.Bare = { argv: [DATA_DIR, 'android'] }
global.BareKit = {
  IPC: {
    on: (event, fn) => { if (event === 'data') onData = fn },
    write: (buf) => sent.push(String(buf))
  }
}

// A stand-in for bare-http1. createAudioShim asks for listen/address/close and nothing more, so
// the port is the only thing that has to be real-ish - it ends up inside every URL the worklet
// mints, which IS under test below.
const fakeHttp = {
  createServer (handler) {
    return {
      handler,
      once () {},
      listen (_port, _host, cb) { if (cb) setImmediate(cb) },
      address () { return { port: 45999 } },
      close (cb) { if (cb) cb() }
    }
  }
}

const realLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'bare-fs') return require('fs')
  if (request === 'bare-path') return require('path')
  if (request === 'bare-http1') return fakeHttp
  return realLoad.call(this, request, ...rest)
}

// THE LOAD ITSELF IS THE FIRST ASSERTION. If any require fails or any top-level reference is
// undefined, this throws here and every test in the file fails loudly - which is the point.
let loadError = null
try {
  require('../src/bare.js')
} catch (e) {
  loadError = e
}

// The hook stays installed for the whole file, NOT just the load. worklet/shim.js requires
// bare-http1 LAZILY, inside createAudioShim, so it is pulled in when a test first brings the
// shim up - long after the initial require. Restoring the loader before that gets you
// `require.addon is not a function` from deep inside a method that has nothing to do with it.
test.after(() => {
  Module._load = realLoad
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch {}
})

// --- helpers ----------------------------------------------------------------

// Call a worklet method the way the shell does, and wait for its reply on the IPC channel.
let seq = 0
function call (method, args = {}, { timeout = 8000 } = {}) {
  const id = 'test-' + (++seq)
  onData(Buffer.from(JSON.stringify({ id, method, args }) + '\n'))
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      for (const line of sent.join('').split('\n')) {
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id !== id) continue
        return msg.error ? reject(new Error(msg.error)) : resolve(msg.result)
      }
      if (Date.now() - started > timeout) return reject(new Error(`no reply to ${method}`))
      setTimeout(poll, 20)
    }
    poll()
  })
}

const events = () => sent.join('').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter((m) => m && m.event)

// --- 1. it evaluates --------------------------------------------------------

test('the worklet module graph evaluates under Node', () => {
  assert.equal(loadError, null, loadError ? `src/bare.js failed to load: ${loadError.message}` : '')
})

test('it announces itself on IPC, so the shell has something to wait for', () => {
  const names = events().map((e) => e.event)
  assert.ok(names.includes('ready'), 'no ready event')
  const logs = events().filter((e) => e.event === 'log').map((e) => e.data.msg)
  assert.ok(logs.includes('worklet:loaded'), 'no worklet:loaded log')
})

test('it registered an IPC data handler', () => {
  assert.equal(typeof onData, 'function')
})

// --- 2. the dispatcher answers ----------------------------------------------

test('an unknown method is refused rather than ignored', async () => {
  await assert.rejects(call('thisIsNotAMethod'), /unknown method/)
})

test('the local methods answer without a host', async () => {
  const s = await call('settings')
  assert.equal(typeof s.theme, 'string')

  // init is the one that matters: it is the single biggest method in the file and it touches
  // identity, settings, the hosts file, the shim and the merged/demo restore paths. The
  // ensureHost bug that motivated this test lived on a path init reaches.
  const state = await call('init')
  assert.match(state.deviceKey, /^[0-9a-f]{64}$/, 'no device key')
  assert.match(state.deviceKeyZ32, /^[a-z0-9]+$/)
  assert.equal(state.host, null, 'a fresh data dir must not be paired')
  assert.equal(state.connected, false)

  assert.deepEqual((await call('listHosts')).hosts, [])
  assert.equal((await call('cacheStats')).count, 0)
  assert.equal((await call('identity')).confirmed, false)
})

test('a method that needs a host fails cleanly instead of hanging', async () => {
  await assert.rejects(call('stats'), /library|paired|reach/i)
})

// --- 3. the demo library, end to end ----------------------------------------
//
// The one part of the app that is entirely local, so the one part that can be driven to
// completion with no device. This is a real regression guard for the demo path: it installs the
// SHIPPED media into a temp cache and then browses it through the worklet's own methods.

test('demo mode installs the shipped media and serves a browsable library', async (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'manifest.json'), 'utf8'))
  const files = {}
  for (const tr of manifest.tracks) files[tr.file] = path.join(DEMO_DIR, tr.file)

  const r = await call('enableDemo', { manifest, files, cover: path.join(DEMO_DIR, manifest.cover) }, { timeout: 30000 })
  assert.equal(r.ok, true)
  assert.equal(r.demo, true)
  assert.equal(r.installed, manifest.tracks.length, 'not every track installed')
  assert.equal(r.failed, 0)
  assert.equal(r.host.demo, true)
  assert.equal(r.host.hostKey, null, 'the demo library must never carry a host key')

  // The bytes really landed - this is what makes playback work, so it is worth asserting rather
  // than trusting the return value.
  assert.equal((await call('cacheStats')).count, manifest.tracks.length)

  await t.test('browse answers from the bundled library', async () => {
    const albums = await call('albums', {})
    assert.equal(albums.items.length, 1)
    assert.equal(albums.items[0].name, manifest.album)

    const tracks = await call('tracks', {})
    assert.equal(tracks.items.length, manifest.tracks.length)
    // A-Z by title is the demo branch's default sort.
    const titles = tracks.items.map((x) => x.title)
    assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)))

    const artists = await call('artists', {})
    assert.equal(artists.items.length, 1)
    assert.equal(artists.items[0].name, manifest.artist)

    const album = await call('album', { id: albums.items[0].id })
    assert.equal(album.tracks.length, manifest.tracks.length)
    assert.deepEqual(album.tracks.map((x) => x.track), [1, 2, 3, 4, 5], 'the album must read 1-5 with no gap')
    // Artwork hangs off the ALBUM, not off each row - the same in every branch of album(), and
    // the album screen draws one cover above a numbered list. Asserting per-track art here would
    // be inventing a requirement the app does not have.
    assert.ok(album.art, 'the album has no artwork URL')
    assert.ok(album.artFull, 'the album has no full-size artwork URL')
    for (const tr of album.tracks) assert.ok(tr.coverId, 'a track with no coverId to resolve art from')
  })

  // EVERY demo branch gets called, not just the ones a reader would think of. A broken call site
  // inside a method is only caught if the test actually REACHES that method - proved by mutation:
  // renaming demo.demoStats left this file green until `stats` was called here.
  await t.test('every browse method has its demo branch exercised', async () => {
    const st = await call('stats')
    assert.equal(st.demo, true)
    assert.equal(st.tracks, manifest.tracks.length)
    assert.ok(st.sorts.tracks.keys.includes('title'))

    const genres = await call('genres', {})
    assert.equal(genres.items.length, manifest.genre ? 1 : 0)
    if (manifest.genre) {
      const g = await call('genre', { id: genres.items[0].id })
      assert.equal(g.albums.length, 1)
      assert.equal((await call('genreTracks', { id: genres.items[0].id })).items.length, manifest.tracks.length)
    }

    const artists = await call('artists', {})
    const artist = await call('artist', { id: artists.items[0].id })
    assert.equal(artist.albums.length, 1)
    assert.equal((await call('artistTracks', { id: artists.items[0].id })).items.length, manifest.tracks.length)

    // Paging is the demo branch's own code too, not the host's.
    const page = await call('tracks', { cursor: 0, limit: 2 })
    assert.equal(page.items.length, 2)
    assert.equal(page.nextCursor, 2)

    // Not merged, so this one must answer empty rather than reaching for an index that is null.
    assert.deepEqual((await call('recentMerged', {})).items, [])

    // The writes that have nowhere to go must no-op rather than queue to an outbox for a library
    // that will never exist.
    assert.equal((await call('resumeSave', { trackId: 'x', positionMs: 1 })).ok, true)
    assert.equal((await call('countBump', { trackId: 'x' })).ok, true)
    assert.equal((await call('toggleFav', { id: 'x', on: true })).supported, false)
    assert.equal((await call('reconnect')).demo, true)
  })

  await t.test('search finds the bundled music and nothing it should not', async () => {
    const hit = await call('search', { q: 'loyalty' })
    assert.equal(hit.artists.length, 1)
    assert.equal(hit.albums.length, 1)
    assert.deepEqual((await call('search', { q: 'zzzznotamatch' })).tracks, [])
  })

  await t.test('urlFor mints a loopback URL with no host to ask', async () => {
    const { items } = await call('tracks', {})
    const { url, port } = await call('urlFor', { trackId: items[0].id })
    assert.equal(port, 45999)
    // The SINGLE-segment form: a demo track has no owning library to name, and the shim's
    // router has to be able to parse what we mint here.
    assert.match(url, /^http:\/\/127\.0\.0\.1:45999\/t\/[a-z0-9]+$/)
    const { parseUrl } = require('../worklet/shim')
    assert.deepEqual(parseUrl(url.replace(/^http:\/\/[^/]+/, '')), {
      kind: 'track', libraryId: null, id: items[0].id, timeOffsetMs: 0
    })
  })

  await t.test('the host-backed features stay off, rather than pretending', async () => {
    assert.equal((await call('favorites')).supported, false)
    assert.equal((await call('playlists')).supported, false)
    assert.equal((await call('requestList')).supported, false)
    assert.equal(await call('resumeLatest'), null)
  })

  await t.test('leaving demo mode gives the bytes back', async () => {
    const out = await call('disableDemo')
    assert.equal(out.retired, true)
    assert.equal(out.removed, manifest.tracks.length)
    assert.equal((await call('cacheStats')).count, 0)
  })
})
