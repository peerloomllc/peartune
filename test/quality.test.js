// The cellular-transcoding decision: original bytes, or a smaller transcode?
//
// This is the whole policy behind "full quality on wifi, capped on cellular,
// overridable in settings" (DECISIONS 2026-07-13). Getting it wrong means either a
// surprise gigabyte over cellular or a needlessly lossy stream on wifi.

const test = require('node:test')
const assert = require('node:assert/strict')

const { streamParams, AUTO_CELLULAR_BITRATE } = require('../worklet/quality')

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

test('garbage or empty falls back to the AUTO default, not a broken transcode', () => {
  assert.equal(streamParams({ streamQuality: 'nonsense' }, 'cellular'), null, 'unknown label -> treated as not-a-bitrate, no transcode')
  // An empty string is falsy, so it lands on the 'auto' default.
  assert.deepEqual(streamParams({ streamQuality: '' }, 'cellular'), { format: 'mp3', bitrate: AUTO_CELLULAR_BITRATE })
  assert.equal(streamParams(null, 'wifi'), null)
})
