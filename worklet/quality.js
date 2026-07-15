// The one decision behind cellular transcoding: original bytes, or a smaller
// transcode? Pure and dependency-free so it can be unit-tested in plain Node, away
// from the Bare-only shim it feeds.
//
// Returns null for DIRECT PLAY (the original file - full quality, seekable), or
// { format, bitrate } to ask the host for a transcode.

// The default bitrate for 'auto' on cellular. mp3 because it plays everywhere; 192 is
// transparent enough on earbuds or a speaker while being ~5x smaller than a FLAC.
const AUTO_CELLULAR_BITRATE = 192

//   original  - always the original file
//   auto      - original on wifi, a capped mp3 on cellular  (the sensible default)
//   <bitrate> - always that mp3 bitrate, on ANY network (a manual override; also what
//               makes the transcode path testable on a wifi-only device)
function streamParams (settings, network) {
  const q = (settings && settings.streamQuality) || 'auto'
  if (q === 'original') return null
  if (q === 'auto') {
    return network === 'cellular' ? { format: 'mp3', bitrate: AUTO_CELLULAR_BITRATE } : null
  }
  const bitrate = Number(q)
  return bitrate ? { format: 'mp3', bitrate } : null
}

module.exports = { streamParams, AUTO_CELLULAR_BITRATE }
