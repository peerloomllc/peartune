'use strict'

// When to save a resume position, and what to save. Pure, like app/starve.js, so the rules can
// be unit-tested away from React Native / ExoPlayer.
//
// WHY THIS LIVES IN THE SHELL (issue #449). The save used to be an 8s timer in the WebView, and
// Android freezes the WebView with the screen. A book playing on into its next part with the
// phone locked never saved the new part, and worse, the frozen WebView woke once mid-lock and
// re-saved the OLD part's old position with a fresh timestamp, so "Continue" went back to it.
// Reproduced on the emulator 2026-10-01. The shell's status listener keeps running while locked
// (the foreground service keeps the process alive), the same reason the sleep timer and the book
// speed live here.

const SAVE_EVERY_MS = 8000
// The first few seconds are not a resume point.
const MIN_POS_MS = 5000
// A song is done at 95%. A book is not: 5% of a 10-hour book is 30 minutes of it, so a book's
// place is kept until its last 30 seconds (proposal 2026-09-13).
const BOOK_TAIL_MS = 30000

// What to save for a track at a position: null to save nothing, else the resumeSave args. A
// position of 0 clears the row on the host, so a finished track starts fresh.
function resumeArgs (track, positionMs, durationMs) {
  if (!track || !track.id) return null
  const pos = positionMs || 0
  if (pos < MIN_POS_MS) return null
  const dur = durationMs || 0
  const book = track.kind === 'book'
  const clear = dur > 0 && (book ? pos > dur - BOOK_TAIL_MS : pos > dur * 0.95)
  return { trackId: track.id, positionMs: clear ? 0 : pos, durationMs: dur }
}

// The track we just left. A NATURAL advance means it played to its end, so clear it, whatever
// the last sample said: the 8s cadence can miss the closing window entirely. A skip keeps the
// last place heard, by the ordinary rules.
function leftTrackArgs (last, natural) {
  if (!last || !last.track || !last.track.id) return null
  if (natural) return { trackId: last.track.id, positionMs: 0, durationMs: last.durationMs || 0 }
  return resumeArgs(last.track, last.positionMs, last.durationMs)
}

// Is a periodic save due? `force` is a pause edge, where the exact spot should land at once.
function saveDue (lastAt, now, force) {
  return !!force || now - (lastAt || 0) >= SAVE_EVERY_MS
}

module.exports = { resumeArgs, leftTrackArgs, saveDue, SAVE_EVERY_MS, MIN_POS_MS, BOOK_TAIL_MS }
