'use strict'

// Where does the NOW-PLAYING track land after the queue is reordered or a track is
// removed? Extracted from the shell so the index math can be unit-tested away from
// React Native / ExoPlayer - the same reason app/starve.js and host/gate.js are pure.
//
// The queue the UI shows is ExoPlayer's media-item order (index 0..n-1); `cur` is the
// media-item index of the track playing right now. When a move or remove shifts the
// current track's slot WITHOUT changing which track it is, ExoPlayer fires no
// onMediaItemTransition, so the shell must recompute `cur` itself to keep the
// now-playing highlight on the right row. These functions mirror exactly what
// ExoPlayer's moveMediaItem / removeMediaItem do to currentMediaItemIndex, so the JS
// mirror and the native mirror agree.

// Move the item at `from` to `to` (array-splice semantics). Returns the new index of
// the track that was at `cur`.
function reindexAfterMove (cur, from, to) {
  if (cur === from) return to // the current track itself moved
  if (from < cur && to >= cur) return cur - 1 // an earlier track jumped to/after us
  if (from > cur && to <= cur) return cur + 1 // a later track jumped to/before us
  return cur
}

// Remove the item at `removed` from a queue of length `len` (BEFORE the removal).
// Returns the new index of the track that was at `cur`. Removing the CURRENT track
// means ExoPlayer advances: the next track slides into this slot, so the index stays
// put - unless we removed the last track, where it steps back to the new last one.
// (Emptying the queue is a stop(), handled by the caller, never reaches here.)
function reindexAfterRemove (cur, removed, len) {
  if (removed < cur) return cur - 1
  if (removed > cur) return cur
  return removed < len - 1 ? removed : Math.max(0, removed - 1)
}

module.exports = { reindexAfterMove, reindexAfterRemove }
