'use strict'

// End-of-chapter sleep: the shell pauses when playback crosses the end of the chapter it is
// in, and NOT when a chapter skip or seek jumps over one (app/chapter-sleep.js).

const test = require('node:test')
const assert = require('node:assert/strict')
const { chapterEndAfter, crossedChapterEnd } = require('../app/chapter-sleep')

const CH = [{ startMs: 0 }, { startMs: 60000 }, { startMs: 120000 }]

test('the end of a chapter is the next one\'s start; the last chapter has none', () => {
  assert.equal(chapterEndAfter(CH, 0), 60000)
  assert.equal(chapterEndAfter(CH, 59999), 60000)
  assert.equal(chapterEndAfter(CH, 60000), 120000)
  assert.equal(chapterEndAfter(CH, 130000), null)
  assert.equal(chapterEndAfter(null, 5), null)
})

test('playing across a chapter end is an ending', () => {
  assert.equal(crossedChapterEnd(CH, 59500, 60200), true)
  assert.equal(crossedChapterEnd(CH, 58000, 59000), false)
  // At 2x a tick covers more of the book, still an ending.
  assert.equal(crossedChapterEnd(CH, 58500, 61500), true)
})

test('a jump over a chapter end is not: skips and seeks re-aim instead of pausing', () => {
  assert.equal(crossedChapterEnd(CH, 10000, 125000), false, 'chapter skip forward')
  assert.equal(crossedChapterEnd(CH, 70000, 5000), false, 'seek back')
  // After the jump, the next honest tick aims at the end of the chapter it landed in.
  assert.equal(crossedChapterEnd(CH, 125000, 125500), false)
  assert.equal(crossedChapterEnd(CH, 65000, 65500), false)
  assert.equal(crossedChapterEnd(CH, 119800, 120300), true)
})
