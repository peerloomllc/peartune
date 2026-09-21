// "Play next" - the tracks land right after the song playing now, in order, and the
// now-playing index does not move.
//
// The shell has no insert-at-index (our expo-audio patch exposes append and move, and
// nothing else), so play-next is append-then-move. That composition is where an
// off-by-one would scramble a queue the user can see, so the move list is checked
// against a brute-force array simulation for every (cur, count) in a small queue -
// including the case that used to be tempting to special-case, the current track
// sitting last.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { reindexAfterMove, nextUpMoves } = require('../app/queue-index')

// Simulate what the shell does: a queue of `len` existing tracks with `cur` playing,
// `count` new tracks appended at the end, then the moves applied in order.
function simulate (cur, len, count) {
  const q = Array.from({ length: len }, (_, i) => `old${i}`)
  const start = q.length
  for (let k = 0; k < count; k++) q.push(`new${k}`)
  let at = cur
  for (const { from, to } of nextUpMoves(cur, start, count)) {
    const [m] = q.splice(from, 1)
    q.splice(to, 0, m)
    at = reindexAfterMove(at, from, to)
  }
  return { q, at }
}

test('the appended tracks end up immediately after the current one, in order', () => {
  for (let len = 1; len <= 6; len++) {
    for (let cur = 0; cur < len; cur++) {
      for (let count = 1; count <= 3; count++) {
        const { q, at } = simulate(cur, len, count)
        assert.equal(q[at], `old${cur}`, `cur=${cur} len=${len} count=${count}: still playing the same track`)
        assert.equal(at, cur, 'the current track does not move')
        for (let k = 0; k < count; k++) {
          assert.equal(q[at + 1 + k], `new${k}`, `cur=${cur} len=${len}: new${k} sits ${k + 1} after the current track`)
        }
        assert.equal(q.length, len + count, 'nothing is lost or duplicated')
      }
    }
  }
})

test('the current track playing LAST means the appended tracks are already in place', () => {
  // from === to for every move, which queueMove treats as a no-op. The result must
  // still be the plain append.
  const { q, at } = simulate(3, 4, 2)
  assert.deepEqual(q, ['old0', 'old1', 'old2', 'old3', 'new0', 'new1'])
  assert.equal(at, 3)
  assert.deepEqual(nextUpMoves(3, 4, 2), [{ from: 4, to: 4 }, { from: 5, to: 5 }])
})

test('nothing to queue means no moves', () => {
  assert.deepEqual(nextUpMoves(0, 3, 0), [])
})

// --- and it is really wired up ----------------------------------------------

const shell = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.tsx'), 'utf8')
const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.jsx'), 'utf8')

test('the shell appends BEFORE moving, and refuses to move when the append failed', () => {
  assert.match(shell, /async function playNext ?\(/, 'the shell must handle playNext')
  assert.match(shell, /playNext: \(\) => playNext\(msg\.args\)/, 'playNext must be routed from the UI')
  // The guard: enqueue reports its own failure and appends nothing, and moving stale
  // indices would then reorder the queue the user still has.
  assert.match(shell, /queueRef\.current\.length !== start \+ q\.length/,
    'playNext must check the append landed before applying any move')
})

test('the UI offers Play next only when there is a current track and shuffle is off', () => {
  assert.match(ui, /canPlayNext=\{!!now && !shuffle\}/,
    'shuffle means ExoPlayer picks the order, so play-next would be a button that lies')
  assert.match(ui, /Play next/, 'the sheet must name the action')
  assert.match(ui, /action === 'next'\) return playNextTracks\(list\)/)
})
