// The now-playing index math after a queue reorder / remove.
//
// Every branch gets a test, and reindexAfterMove is ALSO cross-checked against a
// brute-force array move for every (cur, from, to) in a small queue - because an
// off-by-one here puts the "now playing" highlight on the wrong row, or worse, makes
// the shell's index disagree with ExoPlayer's after a drag.

const test = require('node:test')
const assert = require('node:assert/strict')

const { reindexAfterMove, reindexAfterRemove } = require('../app/queue-index')

// Ground truth: do the array move, tag the current element, find where it lands.
function moveTruth (cur, from, to, len) {
  const arr = Array.from({ length: len }, (_, i) => i)
  const [m] = arr.splice(from, 1)
  arr.splice(to, 0, m)
  return arr.indexOf(cur)
}

test('reindexAfterMove matches a brute-force array move for all positions', () => {
  const len = 6
  for (let cur = 0; cur < len; cur++) {
    for (let from = 0; from < len; from++) {
      for (let to = 0; to < len; to++) {
        assert.equal(
          reindexAfterMove(cur, from, to),
          moveTruth(cur, from, to, len),
          `cur=${cur} from=${from} to=${to}`
        )
      }
    }
  }
})

test('reindexAfterMove: the current track itself is dragged -> follows to `to`', () => {
  assert.equal(reindexAfterMove(2, 2, 5), 5)
  assert.equal(reindexAfterMove(3, 3, 0), 0)
})

test('reindexAfterMove: an earlier track dragged past us -> we shift up one', () => {
  assert.equal(reindexAfterMove(3, 1, 5), 2) // move item 1 to 5, current 3 -> 2
})

test('reindexAfterMove: a later track dragged before us -> we shift down one', () => {
  assert.equal(reindexAfterMove(3, 5, 1), 4) // move item 5 to 1, current 3 -> 4
})

test('reindexAfterMove: a move entirely on one side of us -> unchanged', () => {
  assert.equal(reindexAfterMove(4, 0, 2), 4) // both below current
  assert.equal(reindexAfterMove(1, 3, 5), 1) // both above current
})

test('reindexAfterRemove: removing a track BEFORE the current one shifts us down', () => {
  assert.equal(reindexAfterRemove(3, 1, 6), 2)
})

test('reindexAfterRemove: removing a track AFTER the current one leaves us put', () => {
  assert.equal(reindexAfterRemove(3, 5, 6), 3)
})

test('reindexAfterRemove: removing the CURRENT track keeps the index (next slides in)', () => {
  // cur=2, remove 2, len 6 -> the old track 3 now sits at index 2, and it is the
  // one ExoPlayer advances to, so the index stays 2.
  assert.equal(reindexAfterRemove(2, 2, 6), 2)
})

test('reindexAfterRemove: removing the current track when it is LAST steps back', () => {
  // cur=5 (last of 6), remove 5 -> nothing after it, so step to the new last (4).
  assert.equal(reindexAfterRemove(5, 5, 6), 4)
})

test('reindexAfterRemove: removing the current track in a 2-track queue', () => {
  // cur=1 (last of 2), remove 1 -> step back to 0.
  assert.equal(reindexAfterRemove(1, 1, 2), 0)
  // cur=0 (of 2), remove 0 -> track 1 slides into slot 0, stays 0.
  assert.equal(reindexAfterRemove(0, 0, 2), 0)
})
