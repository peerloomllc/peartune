// When the shell saves a resume position (issue #449). The save moved out of the WebView, which
// Android freezes with the screen, so a book that ran on into its next part while the phone was
// locked lost its place. These pin the rules the WebView used to apply, now in app/resume-save.js,
// plus the track-change case the WebView never handled.

const test = require('node:test')
const assert = require('node:assert/strict')

const { resumeArgs, leftTrackArgs, saveDue, SAVE_EVERY_MS } = require('../app/resume-save')

const song = { id: 's1', kind: 'music' }
const part = { id: 'b1', kind: 'book' }
const MIN = 60000

test('the first few seconds are not a resume point', () => {
  assert.equal(resumeArgs(song, 4999, 3 * MIN), null)
  assert.deepEqual(resumeArgs(song, 5000, 3 * MIN), { trackId: 's1', positionMs: 5000, durationMs: 3 * MIN })
})

test('a song clears at 95%', () => {
  assert.equal(resumeArgs(song, 0.94 * 3 * MIN, 3 * MIN).positionMs, 0.94 * 3 * MIN)
  assert.equal(resumeArgs(song, 0.96 * 3 * MIN, 3 * MIN).positionMs, 0)
})

test('a book part keeps its place until its last 30 seconds', () => {
  const dur = 600 * MIN
  assert.equal(resumeArgs(part, 0.96 * dur, dur).positionMs, 0.96 * dur)
  assert.equal(resumeArgs(part, dur - 29000, dur).positionMs, 0)
})

test('no duration known: save the position, never clear', () => {
  assert.equal(resumeArgs(part, 90000, 0).positionMs, 90000)
})

test('nothing to save without a track id', () => {
  assert.equal(resumeArgs(null, 90000, MIN), null)
  assert.equal(resumeArgs({ kind: 'book' }, 90000, MIN), null)
})

test('a part that played out is cleared, even if the last sample was early', () => {
  // The 8s cadence can miss the closing 30s window; the advance itself says it finished.
  const last = { track: part, positionMs: 100000, durationMs: 150000 }
  assert.deepEqual(leftTrackArgs(last, true), { trackId: 'b1', positionMs: 0, durationMs: 150000 })
})

test('a skipped track keeps the last place heard', () => {
  const last = { track: part, positionMs: 100000, durationMs: 150000 }
  assert.deepEqual(leftTrackArgs(last, false), { trackId: 'b1', positionMs: 100000, durationMs: 150000 })
  assert.equal(leftTrackArgs(null, true), null)
})

test('a save is due every 8s, or at once on a pause', () => {
  assert.equal(saveDue(1000, 1000 + SAVE_EVERY_MS - 1, false), false)
  assert.equal(saveDue(1000, 1000 + SAVE_EVERY_MS, false), true)
  assert.equal(saveDue(1000, 1001, true), true)
})
