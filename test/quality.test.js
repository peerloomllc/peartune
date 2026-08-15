// The cellular-transcoding decision: original bytes, or a smaller transcode?
//
// This is the whole policy behind "full quality on wifi, capped on cellular,
// overridable in settings" (DECISIONS 2026-07-13). Getting it wrong means either a
// surprise gigabyte over cellular or a needlessly lossy stream on wifi.

const test = require('node:test')
const assert = require('node:assert/strict')

const { streamParams, needsTranscode, pinParams, minTranscodeBytes, AUTO_CELLULAR_BITRATE, UNPLAYABLE_WIFI_BITRATE, PIN_TRANSCODE_BITRATE } = require('../worklet/quality')

test('the default (no setting) is AUTO: original on wifi, capped on cellular', () => {
  assert.equal(streamParams({}, 'wifi'), null, 'wifi -> original bytes')
  assert.deepEqual(streamParams({}, 'cellular'), { format: 'mp3', bitrate: AUTO_CELLULAR_BITRATE })
})

test('AUTO on an unknown/none network does NOT transcode (only cellular does)', () => {
  assert.equal(streamParams({ streamQuality: 'auto' }, 'none'), null)
  assert.equal(streamParams({ streamQuality: 'auto' }, 'unknown'), null)
})

test('ORIGINAL never transcodes, not even on cellular', () => {
  assert.equal(streamParams({ streamQuality: 'original' }, 'cellular'), null)
  assert.equal(streamParams({ streamQuality: 'original' }, 'wifi'), null)
})

test('a fixed bitrate ALWAYS transcodes - on any network', () => {
  // This is the manual override, and the reason the transcode path is testable on a
  // wifi-only device: the phone need not be on cellular to exercise it.
  assert.deepEqual(streamParams({ streamQuality: '192' }, 'wifi'), { format: 'mp3', bitrate: 192 })
  assert.deepEqual(streamParams({ streamQuality: '320' }, 'cellular'), { format: 'mp3', bitrate: 320 })
  assert.deepEqual(streamParams({ streamQuality: '128' }, 'none'), { format: 'mp3', bitrate: 128 })
})

// The .wma case (2026-08-14): a real user's library was visible but every track sat
// on "paused" forever - the phone cannot decode WMA, and nothing ever asked the host
// to transcode it. An unplayable container must transcode on EVERY network and under
// EVERY quality setting, or that library simply does not play.
test('an unplayable format transcodes on wifi, where AUTO would direct-play', () => {
  assert.deepEqual(streamParams({}, 'wifi', 'wma', 'android'), { format: 'mp3', bitrate: UNPLAYABLE_WIFI_BITRATE })
  assert.deepEqual(streamParams({}, 'cellular', 'wma', 'android'), { format: 'mp3', bitrate: AUTO_CELLULAR_BITRATE })
})

test('an unplayable format transcodes even on ORIGINAL - original bytes cannot play', () => {
  assert.deepEqual(streamParams({ streamQuality: 'original' }, 'wifi', 'wma', 'android'), { format: 'mp3', bitrate: UNPLAYABLE_WIFI_BITRATE })
})

test('a manual bitrate is respected for unplayable formats too', () => {
  assert.deepEqual(streamParams({ streamQuality: '128' }, 'wifi', 'wma', 'android'), { format: 'mp3', bitrate: 128 })
})

test('playable formats are untouched by the suffix param', () => {
  assert.equal(streamParams({}, 'wifi', 'mp3', 'android'), null)
  assert.equal(streamParams({}, 'wifi', 'flac', 'android'), null)
  assert.equal(streamParams({}, 'wifi', undefined, 'android'), null, 'no suffix known -> the old behavior')
})

test('the unplayable set is per platform: AIFF is Android-only, WMA is universal', () => {
  assert.equal(needsTranscode('aiff', 'android'), true)
  assert.equal(needsTranscode('aif', 'android'), true)
  assert.equal(needsTranscode('aiff', 'ios'), false, 'AVPlayer decodes AIFF natively')
  assert.equal(needsTranscode('wma', 'ios'), true)
  assert.equal(needsTranscode('WMA', 'android'), true, 'case-insensitive')
  assert.equal(needsTranscode('wma', 'somethingelse'), true, 'unknown platform gets the safe (android) set')
})

// Downloads of unplayable formats: a pinned raw .wma is silence offline, so the pin
// path stores the transcode instead - at a FIXED ceiling bitrate, never the network
// policy's, so a download made on cellular is not permanently worse than one made at
// home.
test('a pin of an unplayable format downloads the mp3 transcode at the fixed ceiling', () => {
  assert.deepEqual(pinParams('wma', 'android'), { format: 'mp3', bitrate: PIN_TRANSCODE_BITRATE })
  assert.deepEqual(pinParams('aiff', 'android'), { format: 'mp3', bitrate: PIN_TRANSCODE_BITRATE })
})

test('a pin of a playable format stays raw - full quality, no transcode', () => {
  assert.equal(pinParams('flac', 'android'), null)
  assert.equal(pinParams('mp3', 'android'), null)
  assert.equal(pinParams('aiff', 'ios'), null, 'AIFF plays natively on iOS, keep the original')
  assert.equal(pinParams(undefined, 'android'), null)
})

test('the transcode byte floor guards a half-written download from committing', () => {
  // 30s at 320kbps CBR is 1.2MB; the floor sits at 80% of that.
  assert.equal(minTranscodeBytes(320, 30000), Math.floor(320000 / 8 * 30 * 0.8))
  // A truncated stream (half the bytes) falls under it, a complete one clears it.
  const floor = minTranscodeBytes(320, 30000)
  assert.ok(1200000 / 2 < floor)
  assert.ok(1200000 > floor)
  // No duration known -> only an empty file is rejected.
  assert.equal(minTranscodeBytes(320, null), 1)
  assert.equal(minTranscodeBytes(320, 0), 1)
})

test('garbage or empty falls back to the AUTO default, not a broken transcode', () => {
  assert.equal(streamParams({ streamQuality: 'nonsense' }, 'cellular'), null, 'unknown label -> treated as not-a-bitrate, no transcode')
  // An empty string is falsy, so it lands on the 'auto' default.
  assert.deepEqual(streamParams({ streamQuality: '' }, 'cellular'), { format: 'mp3', bitrate: AUTO_CELLULAR_BITRATE })
  assert.equal(streamParams(null, 'wifi'), null)
})
