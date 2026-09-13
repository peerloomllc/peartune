'use strict'

// Chapters inside an MP4 audiobook (.m4b / .m4a), for proposal 2026-09-13 slice 3.
//
// WHY NOT music-metadata. Its includeChapters was tested on real ffmpeg-made books
// (scripts/make-audiobook-samples.sh) and found 1 of 3 chapters when the index is at the
// start and NONE when it is at the end, which is ffmpeg's default and so how most books
// people convert themselves are laid out. It only reads the QuickTime chapter track, stops
// at the first mdat it meets before the index, and assumes one chapter per chunk.
//
// So this reads the two places a book keeps its chapters, straight from the file:
//
//   1. moov/udta/chpl - the Nero chapter list. A flat table of (start, title). ffmpeg,
//      mp4v2 and most taggers write it. Read first because it is one small atom.
//   2. the QuickTime chapter track - an audio trak whose tref/chap names a text trak; each
//      text sample is one chapter title, and the sample's time is its start. Apple's own
//      files often carry only this.
//
// Only the index (moov) is read, wherever it sits in the file, plus the few bytes of chapter
// text for (2). A 10-hour book's index is well under a megabyte; the audio is never touched.

const fsp = require('fs/promises')

// No real index is anywhere near this. A corrupt size field must not make us allocate
// gigabytes.
const MAX_MOOV_BYTES = 64 * 1024 * 1024
const MAX_CHAPTERS = 5000

async function readAt (fh, pos, len) {
  const buf = Buffer.alloc(len)
  const { bytesRead } = await fh.read(buf, 0, len, pos)
  return bytesRead === len ? buf : buf.subarray(0, bytesRead)
}

// Child atoms of buf[start, end): [{ type, start (payload), end }].
function atoms (buf, start = 0, end = buf.length) {
  const out = []
  let off = start
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    let hdr = 8
    if (size === 1) {
      if (off + 16 > end) break
      size = Number(buf.readBigUInt64BE(off + 8))
      hdr = 16
    } else if (size === 0) {
      size = end - off
    }
    if (size < hdr || off + size > end) break
    out.push({ type, start: off + hdr, end: off + size })
    off += size
  }
  return out
}

const child = (buf, parent, type) => atoms(buf, parent.start, parent.end).find(a => a.type === type)
const path = (buf, parent, types) => types.reduce((p, t) => (p ? child(buf, p, t) : null), parent)

// Find moov at the top level without reading the audio: hop from atom header to header.
async function findMoov (fh, fileSize) {
  let off = 0
  while (off + 8 <= fileSize) {
    const h = await readAt(fh, off, 16)
    if (h.length < 8) return null
    let size = h.readUInt32BE(0)
    const type = h.toString('latin1', 4, 8)
    let hdr = 8
    if (size === 1) {
      if (h.length < 16) return null
      size = Number(h.readBigUInt64BE(8))
      hdr = 16
    } else if (size === 0) {
      size = fileSize - off
    }
    if (size < hdr) return null
    if (type === 'moov') {
      if (size > MAX_MOOV_BYTES) return null
      return readAt(fh, off + hdr, size - hdr)
    }
    off += size
  }
  return null
}

// (1) Nero chpl: FullBox (version, flags), [version 1: 4 reserved bytes], u8 count, then per
// chapter u64 start in 100-nanosecond units, u8 title length, title bytes (UTF-8).
function chplChapters (moov) {
  const root = { start: 0, end: moov.length }
  const chpl = path(moov, root, ['udta', 'chpl'])
  if (!chpl) return []
  let p = chpl.start
  if (p + 5 > chpl.end) return []
  const version = moov[p]
  p += 4
  if (version === 1) p += 4
  if (p + 1 > chpl.end) return []
  const count = moov[p]
  p += 1
  const out = []
  for (let i = 0; i < count && out.length < MAX_CHAPTERS; i++) {
    if (p + 9 > chpl.end) break
    const start = moov.readBigUInt64BE(p)
    const len = moov[p + 8]
    p += 9
    if (p + len > chpl.end) break
    out.push({ title: moov.toString('utf8', p, p + len), startMs: Number(start / 10000n) })
    p += len
  }
  return out
}

function trackInfo (moov, trak) {
  const tkhd = child(moov, trak, 'tkhd')
  const version = tkhd ? moov[tkhd.start] : 0
  const id = tkhd ? moov.readUInt32BE(tkhd.start + (version === 1 ? 20 : 12)) : 0
  const mdhd = path(moov, trak, ['mdia', 'mdhd'])
  const mv = mdhd ? moov[mdhd.start] : 0
  const timescale = mdhd ? moov.readUInt32BE(mdhd.start + (mv === 1 ? 20 : 12)) : 0
  return { id, timescale }
}

// (2) The QuickTime chapter track. Start times from stts, byte offsets from stco/co64 + stsc
// + stsz, and each sample is u16 length + title.
async function trackChapters (fh, moov) {
  const root = { start: 0, end: moov.length }
  const traks = atoms(moov, root.start, root.end).filter(a => a.type === 'trak')
  let chapId = null
  for (const t of traks) {
    const chap = path(moov, t, ['tref', 'chap'])
    if (chap && chap.end - chap.start >= 4) { chapId = moov.readUInt32BE(chap.start); break }
  }
  if (chapId == null) return []
  const trak = traks.find(t => trackInfo(moov, t).id === chapId)
  if (!trak) return []
  const { timescale } = trackInfo(moov, trak)
  const stbl = path(moov, trak, ['mdia', 'minf', 'stbl'])
  if (!stbl || !timescale) return []

  const stts = child(moov, stbl, 'stts')
  const stsz = child(moov, stbl, 'stsz')
  const stsc = child(moov, stbl, 'stsc')
  const stco = child(moov, stbl, 'stco')
  const co64 = child(moov, stbl, 'co64')
  if (!stts || !stsz || !stsc || !(stco || co64)) return []

  const starts = []
  let t = 0
  for (let i = 0, n = moov.readUInt32BE(stts.start + 4); i < n; i++) {
    const e = stts.start + 8 + i * 8
    if (e + 8 > stts.end) break
    const count = moov.readUInt32BE(e)
    const delta = moov.readUInt32BE(e + 4)
    for (let k = 0; k < count && starts.length < MAX_CHAPTERS; k++) { starts.push(t); t += delta }
  }

  const fixed = moov.readUInt32BE(stsz.start + 4)
  const sampleCount = Math.min(moov.readUInt32BE(stsz.start + 8), MAX_CHAPTERS)
  const sizes = []
  for (let i = 0; i < sampleCount; i++) {
    const e = stsz.start + 12 + i * 4
    sizes.push(fixed || (e + 4 <= stsz.end ? moov.readUInt32BE(e) : 0))
  }

  const chunkOffsets = []
  const co = co64 || stco
  for (let i = 0, n = moov.readUInt32BE(co.start + 4); i < n; i++) {
    const e = co.start + 8 + i * (co64 ? 8 : 4)
    if (e + (co64 ? 8 : 4) > co.end) break
    chunkOffsets.push(co64 ? Number(moov.readBigUInt64BE(e)) : moov.readUInt32BE(e))
  }

  const runs = []
  for (let i = 0, n = moov.readUInt32BE(stsc.start + 4); i < n; i++) {
    const e = stsc.start + 8 + i * 12
    if (e + 12 > stsc.end) break
    runs.push({ first: moov.readUInt32BE(e), perChunk: moov.readUInt32BE(e + 4) })
  }

  // Walk chunks, placing each sample at its chunk's offset plus the sizes before it.
  const offsets = []
  for (let c = 0; c < chunkOffsets.length && offsets.length < sampleCount; c++) {
    const run = [...runs].reverse().find(r => r.first <= c + 1)
    let pos = chunkOffsets[c]
    for (let k = 0; k < (run ? run.perChunk : 1) && offsets.length < sampleCount; k++) {
      offsets.push(pos)
      pos += sizes[offsets.length - 1]
    }
  }

  const out = []
  for (let i = 0; i < offsets.length && i < starts.length; i++) {
    if (sizes[i] < 2) continue
    const s = await readAt(fh, offsets[i], Math.min(sizes[i], 2 + 1024))
    if (s.length < 2) continue
    const len = Math.min(s.readUInt16BE(0), s.length - 2)
    out.push({ title: s.toString('utf8', 2, 2 + len), startMs: Math.round(starts[i] * 1000 / timescale) })
  }
  return out
}

// [{ title, startMs }] in start order, or [] for a file with no chapters or one we cannot read.
// A single chapter is not a chapter list, so it comes back as [] too. NEVER throws: a book
// whose chapters cannot be read still plays.
async function readChapters (absPath) {
  let fh = null
  try {
    fh = await fsp.open(absPath, 'r')
    const { size } = await fh.stat()
    const moov = await findMoov(fh, size)
    if (!moov) return []
    let list = chplChapters(moov)
    if (list.length < 2) list = await trackChapters(fh, moov)
    list = list
      .map(c => ({ title: String(c.title || '').replace(/\0/g, '').trim(), startMs: Math.max(0, c.startMs | 0) }))
      .sort((a, b) => a.startMs - b.startMs)
    return list.length >= 2 ? list : []
  } catch {
    return []
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

module.exports = { readChapters }
