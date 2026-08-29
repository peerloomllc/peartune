// The playing track must be favoritable from the player itself (Tim, 2026-08-28).
//
// The heart lived on track rows, album tiles and the artist/album header, but the expanded
// player had none - so the one place you are actually listening to a track was the one place
// you could not favorite it. This is the same class of gap as track-menu.test.js: nothing
// throws when a screen simply never gets the prop, the control just is not there.
//
// So: read the source and require that the <Player> element is handed the heart, and that
// BOTH faces of the expanded player (modern and classic) render it. Deliberately crude - it
// proves the wiring exists, not that the host flips the favorite; the worklet tests cover that.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.jsx'), 'utf8')

// The source text of one JSX element, from its opening tag to its self-closing `/>`.
function element (tag) {
  const start = SRC.indexOf('<' + tag + '\n')
  assert.notEqual(start, -1, `no <${tag}> element found - has it been renamed?`)
  const end = SRC.indexOf('/>', start)
  return SRC.slice(start, end + 2)
}

// The body of a top-level `function Name (` up to the next top-level function.
function body (name) {
  const start = SRC.indexOf('\nfunction ' + name + ' (')
  assert.notEqual(start, -1, `no function ${name} - has it been renamed?`)
  const next = SRC.indexOf('\nfunction ', start + 1)
  return SRC.slice(start, next === -1 ? undefined : next)
}

test('the dock hands the player the playing track\'s heart', () => {
  const el = element('Player')
  assert.match(el, /\bfav=\{/, '<Player> is not told whether the playing track is a favorite')
  assert.match(el, /\bonFav=\{/, '<Player> has no way to toggle the favorite')
  // Keyed on the id play:started carries, so the player heart and the row hearts agree.
  assert.match(el, /favs\.track\.has\(now\.trackId\)/, 'the player heart must read the same id space as the row hearts')
  // Hidden on a host too old for favorites, like every other heart.
  assert.match(el, /favSupported/, 'the player heart must hide when the host lacks favorites')
})

test('both faces of the expanded player render the heart', () => {
  for (const name of ['Player', 'RetroPlayer']) {
    const b = body(name)
    assert.match(b, /onFav && \(/, `${name} does not render a heart`)
    assert.match(b, /'Add to favorites'/, `${name}'s heart has no accessible label`)
  }
  // The modern face passes the heart through to the classic one rather than dropping it.
  assert.match(element('RetroPlayer'), /\bfav=\{fav\} onFav=\{onFav\}/, 'the classic face is not handed the heart')
})
