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

// A PIN (an explicit download) of an unplayable format stores the TRANSCODE, not the
// raw file - raw .wma on disk is silence offline, which defeats the one thing a
// download is for. Playable formats keep downloading the original bytes at full
// quality, unchanged.
//
// The bitrate is FIXED at mp3's ceiling rather than following the network policy:
// a pin is a keep-forever artifact, and baking the moment's cellular cap into it
// would make an album downloaded on the train permanently worse than the same album
// downloaded at home.
const PIN_TRANSCODE_BITRATE = 320

function pinParams (suffix, platform) {
  return needsTranscode(suffix, platform)
    ? { format: 'mp3', bitrate: PIN_TRANSCODE_BITRATE }
    : null
}

// The floor a committed transcode download must clear. A transcode has no known size
// for the sink's own short-read guard, and the host ends the stream cleanly even if
// ffmpeg dies mid-encode - so without this, a half-written file would be stored as a
// complete download and play half an album track forever. CBR mp3 makes the expected
// size predictable: bitrate/8 bytes per second, with 20% slack for container overhead
// variance. No known duration -> floor of one byte (an empty file is never a track).
function minTranscodeBytes (bitrate, durationMs) {
  if (!durationMs || durationMs <= 0) return 1
  return Math.floor((bitrate * 1000 / 8) * (durationMs / 1000) * 0.8)
}

module.exports = {
  streamParams,
  needsTranscode,
  pinParams,
  minTranscodeBytes,
  AUTO_CELLULAR_BITRATE,
  UNPLAYABLE_WIFI_BITRATE,
  PIN_TRANSCODE_BITRATE
}
