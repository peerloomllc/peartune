'use strict'

// Volume levelling (proposal 2026-09-21-volume-levelling): turning the loudness tags
// that are already in people's files into ONE number the player multiplies its volume
// by. Pure, so the decibel maths and the clipping guard are unit-tested without a
// player, a file or a server - the same reason host/lyrics.js and host/gate.js are.
//
// It lives in protocol/ because BOTH ends need it: the host builds the field with
// makeGain, the phone's shell turns it into a volume with factorFor, and the clamp
// they share is the thing that must not drift between them.
//
// What travels on the wire is a track's `gain`:
//
//   { t, a, tp, ap }   t/a = track/album gain in dB, tp/ap = their peaks (0..1+)
//
// Absent keys mean "not tagged". The PHONE picks track or album, because that is a
// listener's preference and it changes without asking the host anything.

// Nothing sensible is outside this. A tag claiming -60 dB is a broken tag, and
// obeying it would mute a song; +6 is as far up as anything should be pushed.
const MIN_DB = -20
const MAX_DB = 6

// ReplayGain is referenced to -18 LUFS and Opus's R128 to -23, so an R128 tag is 5 dB
// quieter than the ReplayGain number for the same audio. R128 values are Q7.8 fixed
// point: 256 units to the decibel.
const R128_REF_OFFSET = 5

function r128ToDb (raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return n / 256 + R128_REF_OFFSET
}

// "-6.50 dB", "-6.5", -6.5 - the tag is a string in most containers.
function parseDb (v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s*dB\s*$/i, '').trim())
  return Number.isFinite(n) ? n : null
}

function parsePeak (v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  // A peak is a sample value: 1.0 is full scale, above it means the file already
  // clips. Zero or negative is meaningless and would divide the guard by nothing.
  return Number.isFinite(n) && n > 0 ? n : null
}

const clampDb = (db) => Math.min(MAX_DB, Math.max(MIN_DB, db))

// Build the wire field from whatever a source gave us. Returns null when nothing was
// tagged, so a track object simply has no `gain` rather than an empty object.
function makeGain ({ trackDb, albumDb, trackPeak, albumPeak } = {}) {
  const t = parseDb(trackDb)
  const a = parseDb(albumDb)
  const tp = parsePeak(trackPeak)
  const ap = parsePeak(albumPeak)
  if (t === null && a === null) return null
  const out = {}
  if (t !== null) out.t = clampDb(t)
  if (a !== null) out.a = clampDb(a)
  if (tp !== null) out.tp = tp
  if (ap !== null) out.ap = ap
  return out
}

const dbToFactor = (db) => Math.pow(10, db / 20)

// The number the player multiplies its volume by. 1 means "leave it alone", which is
// what an untagged track, an unknown mode and `off` all come to.
//
// The clipping guard is the part that matters: a POSITIVE gain on a track that already
// peaks near full scale would distort, and levelling that clips is worse than no
// levelling. With a known peak the factor is reduced to just fit; without one, the
// +6 dB clamp is all the protection there is.
function factorFor (gain, mode = 'track') {
  if (!gain || mode === 'off') return 1

  const db = mode === 'album'
    ? (gain.a ?? gain.t ?? null)
    : (gain.t ?? gain.a ?? null)
  if (db === null) return 1

  const peak = mode === 'album'
    ? (gain.ap ?? gain.tp ?? null)
    : (gain.tp ?? gain.ap ?? null)

  let factor = dbToFactor(clampDb(db))
  if (peak && factor * peak > 1) factor = 1 / peak
  // A peak at or above full scale leaves nothing to give back, so never push above 1.
  return Math.min(Math.max(factor, 0), 4)
}

module.exports = { makeGain, factorFor, dbToFactor, r128ToDb, parseDb, parsePeak, MIN_DB, MAX_DB }
