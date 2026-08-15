// The cellular-transcoding decision: original bytes, or a smaller transcode?
//
// This is the whole policy behind "full quality on wifi, capped on cellular,
// overridable in settings" (DECISIONS 2026-07-13). Getting it wrong means either a
// surprise gigabyte over cellular or a needlessly lossy stream on wifi.

const test = require('node:test')
const assert = require('node:assert/strict')

const { streamParams, needsTranscode, AUTO_CELLULAR_BITRATE, UNPLAYABLE_WIFI_BITRATE } = require('../worklet/quality')

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

test('garbage or empty falls back to the AUTO default, not a broken transcode', () => {
  assert.equal(streamParams({ streamQuality: 'nonsense' }, 'cellular'), null, 'unknown label -> treated as not-a-bitrate, no transcode')
  // An empty string is falsy, so it lands on the 'auto' default.
  assert.deepEqual(streamParams({ streamQuality: '' }, 'cellular'), { format: 'mp3', bitrate: AUTO_CELLULAR_BITRATE })
  assert.equal(streamParams(null, 'wifi'), null)
})
