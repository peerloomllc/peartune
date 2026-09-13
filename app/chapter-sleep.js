'use strict'

// END-OF-CHAPTER SLEEP (proposal 2026-09-13) - pulled out of the shell's playback-status
// listener so it can be tested away from React Native, like starve.js.
//
// The listener sees one position per status tick. "The chapter just ended" is: the previous
// tick was before the next chapter start after it, and this tick is at or past it. A JUMP is
// not an ending: a chapter skip or a seek moves the position by far more than a tick, and must
// re-aim the timer at the chapter it landed in rather than pause straight away.

// Longest honest gap between two ticks. Ticks come about every half second of wall time, and
// at 2x a second of wall time is two of the book's, so 5 s leaves room without letting a
// chapter skip (at least a minute in any real book) pass for playback.
const MAX_TICK_MS = 5000

// The start of the chapter after the one `positionMs` is in, or null when it is in the last
// chapter (which ends with the file) or there are no chapters.
function chapterEndAfter (chapters, positionMs) {
  if (!Array.isArray(chapters)) return null
  for (const c of chapters) {
    if (c && c.startMs > positionMs) return c.startMs
  }
  return null
}

function crossedChapterEnd (chapters, prevMs, posMs) {
  const end = chapterEndAfter(chapters, prevMs)
  if (end == null) return false
  if (posMs < prevMs || posMs - prevMs > MAX_TICK_MS) return false
  return posMs >= end
}

module.exports = { chapterEndAfter, crossedChapterEnd, MAX_TICK_MS }
