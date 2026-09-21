'use strict'

// Lyrics, normalised into the one shape the wire carries (proposal 2026-09-21-lyrics):
//
//   { synced: boolean, lines: [{ t, text }] }
//
// `t` is milliseconds from the start of the track, and is null on every line when
// `synced` is false. Pure functions, kept out of the adapters so the parsing is
// unit-tested without a server, a file or a fixture library - the same reason
// host/gate.js and app/queue-index.js are pure.

// A phone on cellular should never be handed a book because someone's .lrc was
// generated badly. Both limits truncate rather than throw: some words beat none.
const MAX_BYTES = 256 * 1024
const MAX_LINES = 2000

// Timestamps outside the track are a sign of a broken file, not of a long song.
const MAX_MS = 24 * 60 * 60 * 1000

const EMPTY = { synced: false, lines: [] }

// [mm:ss.xx] / [mm:ss.xxx] / [mm:ss] - and LRC allows several on one line, which is
// how a repeated chorus is written without repeating the words.
const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

// Tag lines ([ar:...], [ti:...], [by:...]) carry no words. `offset` is the one that
// changes playback, and it is read separately.
const TAG = /^\[[a-z]+:.*\]$/i

function clampMs (ms) {
  if (!Number.isFinite(ms)) return null
  return Math.min(MAX_MS, Math.max(0, Math.round(ms)))
}

// An [offset:±ms] tag shifts every timestamp - positive means the words come EARLIER,
// which is the opposite of what the sign looks like (it is how much the lyrics lag).
function lrcOffset (text) {
  const m = /^\[offset:\s*([+-]?\d+)\s*\]/im.exec(text)
  if (!m) return 0
  const ms = Number(m[1])
  return Number.isFinite(ms) ? ms : 0
}

// Parse an .lrc (or any text that might be one). Text with no timestamps at all comes
// back UNSYNCED rather than empty - plenty of files are plain words in an .lrc.
function parseLrc (text) {
  if (typeof text !== 'string' || !text.trim()) return EMPTY
  const body = text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text
  const offset = lrcOffset(body)

  const out = []
  let sawStamp = false
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    STAMP.lastIndex = 0
    const stamps = []
    let m
    while ((m = STAMP.exec(line))) {
      const frac = m[3] ? Number(('' + m[3]).padEnd(3, '0')) : 0
      stamps.push(Number(m[1]) * 60000 + Number(m[2]) * 1000 + frac)
    }

    const words = line.replace(STAMP, '').trim()
    if (!stamps.length) {
      // A tag line with no words is metadata; anything else is an unsynced line.
      if (TAG.test(line)) continue
      if (words) out.push({ t: null, text: words })
      continue
    }
    sawStamp = true
    // An empty stamped line is a real thing: it is the gap between verses, and
    // keeping it stops the previous line staying highlighted through the silence.
    for (const s of stamps) out.push({ t: clampMs(s - offset), text: words })
  }

  return finish(out, sawStamp)
}

// Words with no timings at all - an embedded tag, or Subsonic's classic getLyrics.
function parsePlain (text) {
  if (typeof text !== 'string' || !text.trim()) return EMPTY
  const body = text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text
  const lines = body.split(/\r?\n/).map(l => ({ t: null, text: l.trim() }))
  return finish(lines, false)
}

// Lines that already carry times - OpenSubsonic's structuredLyrics, Jellyfin's
// Lyrics[]. `start` is whatever the caller's unit was, converted before it gets here.
function fromTimedLines (lines) {
  if (!Array.isArray(lines)) return EMPTY
  const out = []
  let sawStamp = false
  for (const l of lines) {
    const text = typeof l?.text === 'string' ? l.text.trim() : ''
    // An EXPLICIT null means "this line has no time" and must stay null. Number(null)
    // is 0, which would silently pin an untimed line to the start of the track and
    // leave the whole set looking synced.
    const raw = l?.t
    const t = raw === null || raw === undefined || raw === '' ? null : clampMs(Number(raw))
    if (t !== null) sawStamp = true
    out.push({ t, text })
  }
  return finish(out, sawStamp)
}

// The one exit: sort, truncate, and drop leading/trailing blanks. A file that is
// PARTLY timed is served unsynced - a highlight that jumps to the top of the song
// every few lines is worse than no highlight (proposal, "Timings that lie").
function finish (lines, sawStamp) {
  let rows = lines
  if (sawStamp) {
    if (rows.some(l => l.t === null)) return finish(rows.map(l => ({ t: null, text: l.text })), false)
    rows = rows.slice().sort((a, b) => a.t - b.t)
  }
  // Blank lines at the ends are padding from the file, not part of the words.
  while (rows.length && !rows[0].text) rows.shift()
  while (rows.length && !rows[rows.length - 1].text) rows.pop()
  if (!rows.length) return EMPTY
  if (rows.length > MAX_LINES) rows = rows.slice(0, MAX_LINES)
  return { synced: sawStamp, lines: rows }
}

module.exports = { parseLrc, parsePlain, fromTimedLines, MAX_BYTES, MAX_LINES, EMPTY }
