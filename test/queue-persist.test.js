// The saved queue must survive a stop the user did not ask for (Tim, 2026-08-29).
//
// Repro on Jellyfin: artist -> Shuffle, screen off, pause, resume; when the song ended the
// queue was gone and the app came back empty. Two things stacked: shuffle never reached a
// freshly built player (the UI sends `shuffle` before `play`), so the array played IN ORDER
// from a random index and "ended" a few songs in; and every stop() - including the starve
// path when the idle link could not load the next track - deleted queue.json. Both are
// shell logic that no unit test can drive, so this pins the source the way
// track-menu.test.js does: the wiring, not the behaviour.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const SHELL = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.tsx'), 'utf8')
const BARE = fs.readFileSync(path.join(__dirname, '..', 'src', 'bare.js'), 'utf8')
const UI = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.jsx'), 'utf8')

// The body of a top-level `function name (` in the shell, up to the next blank-line-separated
// function. Crude, but the shell's functions are laid out that way.
function body (name) {
  const start = SHELL.indexOf(`\n  function ${name} (`)
  const alt = SHELL.indexOf(`\n  async function ${name} (`)
  const i = start === -1 ? alt : (alt === -1 ? start : Math.min(start, alt))
  assert.notEqual(i, -1, `no function ${name} in app/index.tsx - renamed?`)
  const next = SHELL.indexOf('\n  }\n', i)
  return SHELL.slice(i, next + 4)
}

test('stop() forgets the saved queue ONLY when told to', () => {
  const occurrences = SHELL.split("call('clearQueueState')").length - 1
  assert.equal(occurrences, 1, 'clearQueueState must be called from exactly one place, inside stop()')
  const stop = body('stop')
  assert.match(stop, /if \(forget\) call\('clearQueueState'\)/, 'the delete must be gated on { forget: true }')
})

test('the stops the user did not ask for keep the queue', () => {
  // The starve path and the end-of-playlist path must be plain stop() calls.
  assert.match(body('onStarved'), /\n    stop\(\)\n/, 'onStarved must not forget the queue')
  const ended = SHELL.slice(SHELL.indexOf('const playlistEnded ='), SHELL.indexOf('const playlistEnded =') + 400)
  assert.match(ended, /else \{ stop\(\) \}/, 'the end of the playlist must not forget the queue')
})

test('the deliberate discards still forget it', () => {
  for (const name of ['onHandedOff']) {
    assert.match(body(name), /stop\(\{ forget: true \}\)/, `${name} must forget the stale queue`)
  }
  assert.match(SHELL, /msg\.method === 'forget'\) stop\(\{ forget: true \}\)/, 'unpairing must forget the queue')
})

test('play() applies shuffle and repeat to the player it just built', () => {
  const play = body('play')
  assert.match(play, /ensurePlayer\(urls, index\)[\s\S]*px\(\)\?\.setShuffle\(shuffleRef\.current\)/, 'shuffle is not re-applied after ensurePlayer in play()')
  assert.match(play, /px\(\)\?\.setRepeatMode\(repeatRef\.current\)/, 'repeat is not re-applied in play()')
})

test('an empty snapshot never overwrites a saved queue, on either side', () => {
  const persist = body('persistQueue')
  assert.match(persist, /if \(!queueRef\.current\.length\) return/, 'the shell must not persist an empty queue')
  const i = BARE.indexOf('async saveQueueState (')
  const fn = BARE.slice(i, BARE.indexOf('\n  },', i))
  assert.match(fn, /if \(!items\.length\) return/, 'the worklet must refuse an empty snapshot')
})

test('the queue snapshot is written through a temp file and a rename', () => {
  const i = BARE.indexOf('async saveQueueState (')
  assert.notEqual(i, -1)
  const fn = BARE.slice(i, BARE.indexOf('\n  },', i))
  assert.match(fn, /queueFile\(\) \+ '\.tmp'/, 'no temp file')
  assert.match(fn, /fs\.renameSync\(tmp, queueFile\(\)\)/, 'no rename into place')
  assert.doesNotMatch(fn, /fs\.writeFileSync\(queueFile\(\)/, 'the final file must never be written directly')
})

test('the UI retries the restore when the host connects', () => {
  const i = UI.indexOf("on('host:connected'")
  const handler = UI.slice(i, UI.indexOf('\n      })', i))
  assert.match(handler, /call\('restore'\)/, 'host:connected must re-run restore')
})
