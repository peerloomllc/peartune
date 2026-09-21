// Volume levelling (proposal 2026-09-21): the decibel maths, the clipping guard, and
// the three adapters that can read a loudness tag.
//
// The guard is the part with teeth. A POSITIVE gain applied to a track that already
// peaks near full scale distorts, and distortion is a worse outcome than the uneven
// volume this feature exists to fix - so every path that can raise the volume is
// tested against a peak.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const hcrypto = require('hypercore-crypto')

const { makeGain, factorFor, dbToFactor, r128ToDb, MIN_DB, MAX_DB } = require('../protocol/gain')
const { SubsonicAdapter } = require('../host/adapters/subsonic')
const { JellyfinAdapter } = require('../host/adapters/jellyfin')
const { libraryId } = require('../protocol/ids')

const lib = libraryId(hcrypto.keyPair().publicKey)
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`)

// --- the maths --------------------------------------------------------------

test('decibels become the factor the player multiplies by', () => {
  close(dbToFactor(0), 1)
  close(dbToFactor(-6.0206), 0.5, 1e-4) // minus six dB is half the amplitude
  close(dbToFactor(6.0206), 2, 1e-4)
})

test('an R128 tag is fixed point AND a different reference', () => {
  // Q7.8: 256 units to the dB. Opus references -23 LUFS, ReplayGain -18, so +5.
  assert.equal(r128ToDb(-1280), 0, '-5 dB against -23 LUFS is 0 against -18')
  assert.equal(r128ToDb(0), 5)
  assert.equal(r128ToDb('not a number'), null)
})

test('the tag is parsed out of whatever string the container kept it in', () => {
  assert.deepEqual(makeGain({ trackDb: '-6.50 dB' }), { t: -6.5 })
  assert.deepEqual(makeGain({ trackDb: -6.5 }), { t: -6.5 })
  assert.deepEqual(makeGain({ trackDb: ' -6.5 ' }), { t: -6.5 })
  assert.equal(makeGain({ trackDb: 'loud' }), null, 'an unparseable tag is no tag')
  assert.equal(makeGain({}), null, 'nothing tagged means no gain field at all')
  assert.equal(makeGain({ trackPeak: 0.9 }), null, 'a peak alone says nothing about level')
})

test('a nonsense tag is clamped rather than obeyed', () => {
  assert.equal(makeGain({ trackDb: -60 }).t, MIN_DB, 'a tag cannot mute a song')
  assert.equal(makeGain({ trackDb: 30 }).t, MAX_DB, 'nor blow the output')
  assert.equal(makeGain({ trackDb: 0, trackPeak: '0' }).tp, undefined, 'a zero peak is not a peak')
  assert.equal(makeGain({ trackDb: 0, trackPeak: -1 }).tp, undefined)
})

test('the mode picks which number is used, and falls back to the other one', () => {
  const g = { t: -8, a: -4 }
  close(factorFor(g, 'track'), dbToFactor(-8))
  close(factorFor(g, 'album'), dbToFactor(-4))
  close(factorFor({ a: -4 }, 'track'), dbToFactor(-4), 1e-9, 'track-only missing: use the album figure')
  close(factorFor({ t: -8 }, 'album'), dbToFactor(-8))
})

test('off, untagged, and an old host that sends nothing all leave the volume alone', () => {
  assert.equal(factorFor({ t: -8 }, 'off'), 1)
  assert.equal(factorFor(null, 'track'), 1)
  assert.equal(factorFor(undefined, 'album'), 1)
  assert.equal(factorFor({}, 'track'), 1)
})

test('THE CLIPPING GUARD: a positive gain never pushes a loud track past full scale', () => {
  // +6 dB would double it, but the file already peaks at 0.99.
  const f = factorFor({ t: 6, tp: 0.99 }, 'track')
  close(f, 1 / 0.99)
  assert.ok(f * 0.99 <= 1 + 1e-12, 'the result cannot clip')

  // A file already at full scale gets nothing.
  assert.equal(factorFor({ t: 6, tp: 1 }, 'track'), 1)
  // One that already clips is pulled DOWN to fit.
  assert.ok(factorFor({ t: 6, tp: 1.5 }, 'track') < 1)
})

test('a NEGATIVE gain is never touched by the guard - quieter cannot clip', () => {
  close(factorFor({ t: -6, tp: 1 }, 'track'), dbToFactor(-6))
})

test('album mode uses the album peak, not the track one', () => {
  const g = { t: 6, a: 6, tp: 0.5, ap: 0.99 }
  close(factorFor(g, 'album'), 1 / 0.99, 1e-9) // the album peak binds
  // The track peak leaves room for the whole +6 dB, so the guard does not bind at all.
  close(factorFor(g, 'track'), dbToFactor(6))
})

test('with no peak at all, the +6 dB clamp is the only protection - and it holds', () => {
  assert.ok(factorFor({ t: 99 }, 'track') <= dbToFactor(MAX_DB) + 1e-9)
})

// --- the adapters -----------------------------------------------------------

test('subsonic: OpenSubsonic replayGain lands on the track', () => {
  const a = new SubsonicAdapter({ url: 'http://nav:4533/', username: 'u', password: 'p', libraryId: lib })
  const t = a._track({
    id: 's1', title: 'A', duration: 100,
    replayGain: { trackGain: -7.5, albumGain: -5.25, trackPeak: 0.97, albumPeak: 0.99 }
  })
  assert.deepEqual(t.gain, { t: -7.5, a: -5.25, tp: 0.97, ap: 0.99 })
})

test('subsonic: a server without the extension sends no gain field at all', () => {
  const a = new SubsonicAdapter({ url: 'http://nav:4533/', username: 'u', password: 'p', libraryId: lib })
  assert.equal('gain' in a._track({ id: 's1', title: 'A' }), false)
})

test('jellyfin: NormalizationGain is already decibels', () => {
  const a = new JellyfinAdapter({ url: 'http://jf:8096/', username: 'u', password: 'p', libraryId: lib })
  const t = a._track({ Id: 'i1', Name: 'A', NormalizationGain: -6.25, AlbumNormalizationGain: -4 })
  assert.deepEqual(t.gain, { t: -6.25, a: -4 })
  assert.equal('gain' in a._track({ Id: 'i2', Name: 'B' }), false)
})

test('folder: ReplayGain and R128 tags are both read off a real file', async () => {
  const { FolderAdapter } = require('../host/adapters/folder')
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pt-gain-'))
  const { execFileSync } = require('child_process')
  let made = false
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1',
      '-metadata', 'replaygain_track_gain=-6.50 dB', '-metadata', 'replaygain_track_peak=0.988',
      path.join(dir, 'rg.mp3'), '-y'])
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1',
      '-c:a', 'libopus', '-metadata', 'R128_TRACK_GAIN=-1280',
      path.join(dir, 'r128.opus'), '-y'])
    made = true
  } catch {} // no ffmpeg on this machine: the pure maths above is still the substance

  if (made) {
    const a = new FolderAdapter({ root: dir, libraryId: lib })
    await a.scan()
    const rows = [...a.tracks.values()]
    const rg = rows.find(t => /rg/.test(t.path))
    const r128 = rows.find(t => /r128/.test(t.path))
    assert.deepEqual(rg?.gain, { t: -6.5, tp: 0.988 }, 'ReplayGain from an ID3 TXXX frame')
    assert.deepEqual(r128?.gain, { t: 0 }, 'R128 converted from Q7.8 and re-referenced')
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

// --- the shell: ONE owner of player.volume ----------------------------------

test('nothing in the shell writes player.volume except applyVolume', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.tsx'), 'utf8')
  assert.match(shell, /function applyVolume \(/, 'the shell must have the one owner')

  // The bug this prevents: the sleep fade used to "restore" a literal 1, which on a
  // levelled track came back LOUDER than it started - and while casting it un-muted
  // the phone, putting a second copy of the song in the room.
  const writes = shell.match(/\b(p|player\.current)\.volume\s*=/g) || []
  assert.equal(writes.length, 1, `player.volume is written ${writes.length} times; it must be exactly once, inside applyVolume`)
  assert.ok(!/volume = 1\b/.test(shell), 'nothing may restore a literal 1 any more')
})

test('the level is re-applied at every track change, because one player spans the queue', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.tsx'), 'utf8')
  const announce = shell.slice(shell.indexOf('function announce (i: number)'))
  assert.match(announce.slice(0, 600), /applyVolume\(i\)/,
    'gapless means the player is never rebuilt between tracks, so the volume has to move at the boundary')
})

test('the shell can only turn things DOWN - a player volume has no headroom above 1', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.tsx'), 'utf8')
  assert.match(shell, /Math\.max\(0, Math\.min\(1, level\)\)/,
    'a +5 dB quiet master must be left alone rather than boosted into headroom we do not have')
})

test('the applied level is reported, so "why is this quieter" is answerable', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.tsx'), 'utf8')
  assert.match(shell, /level: levelFor\(queueRef\.current\[indexRef\.current\]\)/,
    'play:status must carry the level in force')
  // ...the level actually IN FORCE, clamped like the player is. A report of 1.778 for a
  // track playing at 1 was the first thing the device check turned up.
  const lf = shell.slice(shell.indexOf('function levelFor'))
  assert.match(lf.slice(0, 200), /Math\.min\(1, gainFactor\(t\)\)/)
})

test('the queue carries the gain, or the shell has nothing to read', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.jsx'), 'utf8')
  assert.match(ui, /gain: x\.gain \?\? null/, 'toQueue must carry it')
  assert.match(ui, /call\('gainMode', \{ mode: gainMode \}\)/, 'the shell must be told the mode')
})
