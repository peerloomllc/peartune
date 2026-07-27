// Which copy to fall back to when a stream dies mid-track.
//
// Tim, 2026-07-26: if two libraries hold the same song and one revokes you mid-song, the music
// should carry on from the other. The NEXT track already does that (routeTrack -> bestCopy); this
// is for the track already playing, whose URL was resolved to the library that just went away.
// See proposals/2026-07-27-mid-song-failover.md.
//
// The decision is separated from the plumbing because the interesting part is the SAFETY question:
// can we splice mid-stream, or must the track be re-opened? Splicing continues one HTTP response
// with bytes from a different host, which is only correct if the two copies are the same bytes.
// The merge deliberately prefers a lossless primary, so FLAC-here / MP3-there is normal - and
// splicing those produces noise, not music.

// `identical` demands size AND suffix. Size alone would be enough almost always; the suffix check
// costs nothing and rules out the one case where equal length means different bytes. Neither is
// proof, which is why the caller must abort a cache write across a splice rather than store a file
// assembled from two sources.
function sameBytes (a, b) {
  if (!a || !b) return false
  const sa = Number(a.size) || 0
  const sb = Number(b.size) || 0
  if (!sa || !sb || sa !== sb) return false
  return String(a.suffix || '') === String(b.suffix || '')
}

// track: the merged track ({ copies: [{ libraryId, id, size, suffix }] }), as the index holds it.
// failedLibraryId: the library whose stream just died - never chosen.
// connected: Set of libraryIds reachable RIGHT NOW (live link state, so a revoked library is
//   already excluded).
// currentId: the copy id we were streaming, used to find what we were playing so `identical` is
//   judged against THAT copy rather than the primary.
// Returns { libraryId, id, identical } or null when there is nothing to fall back to.
function pickAltCopy ({ track, failedLibraryId, connected, currentId }) {
  if (!track || !Array.isArray(track.copies)) return null
  const live = connected instanceof Set ? connected : new Set(connected || [])
  const current = track.copies.find((c) => c && c.id === currentId) || null
  for (const c of track.copies) {
    if (!c || !c.libraryId || !c.id) continue
    if (c.libraryId === failedLibraryId) continue
    if (!live.has(c.libraryId)) continue
    return { libraryId: c.libraryId, id: c.id, identical: sameBytes(current, c) }
  }
  return null
}

module.exports = { pickAltCopy, sameBytes }
