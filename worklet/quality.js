// The one decision behind cellular transcoding: original bytes, or a smaller
// transcode? Pure and dependency-free so it can be unit-tested in plain Node, away
// from the Bare-only shim it feeds.
//
// Returns null for DIRECT PLAY (the original file - full quality, seekable), or
// { format, bitrate } to ask the host for a transcode.

// The default bitrate for 'auto' on cellular. mp3 because it plays everywhere; 192 is
// transparent enough on earbuds or a speaker while being ~5x smaller than a FLAC.
const AUTO_CELLULAR_BITRATE = 192

// Formats the phone CANNOT DECODE, per platform. These never direct-play: the raw
// bytes reach the player and it just sits there, which the UI renders as "paused"
// forever (found 2026-08-14 with a real .wma library). The scanner indexes them on
// purpose - the fix is to transcode, not to hide the music.
//   android - ExoPlayer ships no WMA/ASF and no AIFF extractor
//   ios     - AVPlayer plays AIFF natively; WMA plays nowhere
const UNPLAYABLE = {
  android: ['wma', 'aiff', 'aif'],
  ios: ['wma']
}

// What an unplayable format transcodes to when nothing else forces a bitrate. On
// cellular the normal cap applies; on wifi there is no bandwidth reason to cap, so
// take mp3's ceiling - the source is almost always lossy (wma) already.
const UNPLAYABLE_WIFI_BITRATE = 320

function needsTranscode (suffix, platform) {
  const list = UNPLAYABLE[platform] || UNPLAYABLE.android
  return list.includes(String(suffix || '').toLowerCase())
}

//   original  - always the original file
//   auto      - original on wifi, a capped mp3 on cellular  (the sensible default)
//   <bitrate> - always that mp3 bitrate, on ANY network (a manual override; also what
//               makes the transcode path testable on a wifi-only device)
//
// `suffix` (the track's container, e.g. 'wma') and `platform` outrank all three: a
// format the phone cannot decode is transcoded EVEN ON 'original', because "original"
// means "do not degrade for bandwidth", not "hand me bytes that cannot play".
function streamParams (settings, network, suffix, platform) {
  const q = (settings && settings.streamQuality) || 'auto'
  if (needsTranscode(suffix, platform)) {
    const manual = Number(q)
    const bitrate = manual || (network === 'cellular' ? AUTO_CELLULAR_BITRATE : UNPLAYABLE_WIFI_BITRATE)
    return { format: 'mp3', bitrate }
  }
  if (q === 'original') return null
  if (q === 'auto') {
    return network === 'cellular' ? { format: 'mp3', bitrate: AUTO_CELLULAR_BITRATE } : null
  }
  const bitrate = Number(q)
  return bitrate ? { format: 'mp3', bitrate } : null
}

module.exports = { streamParams, needsTranscode, AUTO_CELLULAR_BITRATE, UNPLAYABLE_WIFI_BITRATE }
