#!/usr/bin/env node
// Build a SYNTHETIC library for the store screenshots - fictional artists, generated covers.
//
// WHY THIS EXISTS. The old fixture (scripts/screenshot-fixture.sh) snapshots a slice of Tim's
// REAL library, so every grid renders real commercial album art. That is fine on a store page
// and not fine in a public MIT repo, so the fixture and the captures are gitignored - and a
// zapstore.yaml in a public repo cannot point at files that are not in it. Net effect, found
// when the first Zapstore listing went up with no screenshots: there was nothing to upload.
//
// So: generate the library instead. Nothing here belongs to anybody. Every artist and album
// name is made up, every cover is drawn by this script, and the whole thing is DETERMINISTIC -
// the same seed gives byte-identical covers, so a contributor on a clean checkout regenerates
// exactly what shipped rather than something that merely looks similar.
//
// Output is the same shape screenshot-fixture-pack.js produces, because src/ui/screenshot.js
// is the consumer and it must not be able to tell the difference:
//
//   { genre, albums: [{ id, name, artist, year, songCount, coverId }], covers: { id: dataURL } }
//
// Usage:
//   node scripts/make-screenshot-fixture.js [count]     # default 40, enough to fill a grid
//
// Then capture as usual: ./scripts/android-screenshots.sh

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const COUNT = Number(process.argv[2]) || 40
const OUT_DIR = path.join(__dirname, '..', 'metadata', 'screenshot-fixtures')
const SIZE = 400 // covers render at ~150-300px in the grids; 400 has headroom without bloat

// --- deterministic randomness ------------------------------------------------
// Seeded so re-running produces the same library. A hash of the name seeds each cover, so
// adding an album at the end never re-rolls the ones before it.
function hash (s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function rng (seed) {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length]

// --- the fictional library ---------------------------------------------------
// Names are built from parts rather than listed, so 40 albums do not read as a list somebody
// wrote in ten minutes. Deliberately evocative-but-nobody's: no real band shares these.
const ADJ = ['Slow', 'Paper', 'Neon', 'Hollow', 'Amber', 'Quiet', 'Velvet', 'Iron', 'Wandering',
  'Northern', 'Glass', 'Midnight', 'Salt', 'Copper', 'Distant', 'Lantern', 'Winter', 'Silver']
const NOUN = ['Harbour', 'Machines', 'Cartographers', 'Signal', 'Orchard', 'Tides', 'Atlas',
  'Wolves', 'Static', 'Meridian', 'Lantern', 'Foxes', 'Circuit', 'Pilgrims', 'Ferry', 'Hours']
// Album titles come from two templates rather than one, because a single list of qualifiers
// against a single list of nouns produces "Every Gardens" and "Half Mornings" - and a store
// screenshot full of not-quite-English is worse than a plain one. So: qualifiers that want a
// plural, qualifiers that want a singular, and never the two mixed.
const PLURAL_A = ['Long', 'Small', 'Blue', 'Open', 'Half the', 'A Thousand', 'Further', 'Late',
  'Quiet', 'Paper', 'Slow']
const PLURAL_B = ['Weather Fronts', 'Rooms', 'Machines', 'Harbours', 'Summers', 'Letters',
  'Stations', 'Mornings', 'Winters', 'Distances', 'Signals', 'Gardens', 'Cities']
const SINGULAR_A = ['Every', 'Another', 'The Last', 'Second', 'First', 'No Ordinary', 'The Quiet',
  'One More', 'The Longest']
const SINGULAR_B = ['Daylight', 'Country', 'Harbour', 'Winter', 'Morning', 'Signal', 'Distance',
  'Crossing', 'Summer', 'Atlas', 'Ferry', 'Orchard']

function library (count) {
  const r = rng(0x50454152) // "PEAR"
  const seen = new Set()
  const albums = []
  let guard = 0
  while (albums.length < count && guard++ < count * 40) {
    const artist = `${pick(r, ADJ)} ${pick(r, NOUN)}`
    const name = r() > 0.5
      ? `${pick(r, PLURAL_A)} ${pick(r, PLURAL_B)}`
      : `${pick(r, SINGULAR_A)} ${pick(r, SINGULAR_B)}`
    const key = artist + '|' + name
    if (seen.has(key)) continue
    seen.add(key)
    const id = 'fx' + hash(key).toString(36)
    albums.push({
      id,
      name,
      artist,
      year: 2009 + Math.floor(r() * 17),
      songCount: 6 + Math.floor(r() * 8),
      coverId: 'c' + hash('cover:' + key).toString(36)
    })
  }
  return albums
}

// --- the covers --------------------------------------------------------------
// Drawn, not photographed, and drawn to look like a record sleeve rather than a placeholder:
// a two-tone diagonal gradient, one geometric mark, and the title set small in a corner. The
// grid shows them at thumbnail size, so the mark carries and the text is texture.
const PALETTES = [
  ['#1b2a4a', '#4f7cac'], ['#2d1b34', '#a05c7b'], ['#14322b', '#4f9d69'],
  ['#3a2313', '#c88a4b'], ['#22242b', '#8e9aaf'], ['#331c1c', '#b5533c'],
  ['#1d2f38', '#5aa9b8'], ['#2b2416', '#b9a44c'], ['#241a33', '#7b6bab'],
  ['#102a2a', '#3f8f8f']
]

function drawCover (album, dest) {
  const r = rng(hash(album.coverId))
  const [dark, bright] = pick(r, PALETTES)
  const S = SIZE
  const args = [
    '-size', `${S}x${S}`,
    `gradient:${dark}-${bright}`,
    '-rotate', String(Math.floor(r() * 4) * 90)
  ]

  // ONE MARK PER SLEEVE, FROM EIGHT. The first cut had three, and forty albums drawn from three
  // marks does not look like a label - it looks like a template, which is exactly what a store
  // browser should not be thinking about. Eight marks across ten palettes, with the position and
  // size rolled per album, gives a grid where no two tiles rhyme.
  const cx = Math.floor(S * (0.3 + r() * 0.4))
  const cy = Math.floor(S * (0.28 + r() * 0.34))
  const rad = Math.floor(S * (0.12 + r() * 0.16))
  const shape = Math.floor(r() * 8)
  const ink = r() > 0.5 ? '#f4f1ea' : '#12141a'
  const sw = Math.max(2, Math.floor(S * 0.012))
  args.push('-fill', 'none', '-stroke', ink, '-strokewidth', String(sw))
  if (shape === 0) {
    args.push('-draw', `circle ${cx},${cy} ${cx + rad},${cy}`)
    args.push('-draw', `circle ${cx},${cy} ${cx + Math.floor(rad * 0.45)},${cy}`)
  } else if (shape === 1) {
    args.push('-draw', `rectangle ${cx - rad},${cy - rad} ${cx + rad},${cy + rad}`)
    args.push('-draw', `line ${cx - rad},${cy + rad} ${cx + rad},${cy - rad}`)
  } else if (shape === 2) {
    const step = Math.max(6, Math.floor(rad / 3))
    for (let i = 0; i < 4; i++) {
      args.push('-draw', `line ${cx - rad},${cy - rad + i * step} ${cx + rad},${cy - rad + i * step}`)
    }
  } else if (shape === 3) {
    // Concentric arcs, like a signal fanning out.
    for (let i = 1; i <= 3; i++) {
      const rr = Math.floor(rad * (i / 3))
      args.push('-draw', `arc ${cx - rr},${cy - rr} ${cx + rr},${cy + rr} 200,340`)
    }
  } else if (shape === 4) {
    // A grid of dots.
    args.push('-fill', ink, '-stroke', 'none')
    const n = 4
    const gap = Math.floor((rad * 2) / (n - 1))
    const dot = Math.max(2, Math.floor(S * 0.016))
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        const x = cx - rad + a * gap
        const y = cy - rad + b * gap
        args.push('-draw', `circle ${x},${y} ${x + dot},${y}`)
      }
    }
    args.push('-fill', 'none', '-stroke', ink)
  } else if (shape === 5) {
    args.push('-draw', `polygon ${cx},${cy - rad} ${cx + rad},${cy + rad} ${cx - rad},${cy + rad}`)
  } else if (shape === 6) {
    // A horizon: one rule across the sleeve with a disc sitting on it.
    const y = cy
    args.push('-draw', `line ${Math.floor(S * 0.08)},${y} ${Math.floor(S * 0.92)},${y}`)
    args.push('-draw', `circle ${cx},${y - Math.floor(rad * 0.6)} ${cx + Math.floor(rad * 0.6)},${y - Math.floor(rad * 0.6)}`)
  } else {
    // Offset bars of unequal length, ragged right.
    const step = Math.max(8, Math.floor(rad / 2.5))
    args.push('-strokewidth', String(sw * 2))
    for (let i = 0; i < 4; i++) {
      const len = Math.floor(rad * (0.5 + ((i * 7) % 5) / 5))
      args.push('-draw', `line ${cx - rad},${cy - rad + i * step} ${cx - rad + len * 2},${cy - rad + i * step}`)
    }
    args.push('-strokewidth', String(sw))
  }

  // The type. Small, bottom-left, the way a sleeve credits itself.
  const pad = Math.floor(S * 0.07)
  args.push(
    '-stroke', 'none',
    '-fill', '#f4f1ea',
    '-pointsize', String(Math.floor(S * 0.062)),
    '-annotate', `+${pad}+${S - pad - Math.floor(S * 0.05)}`, album.name,
    '-fill', '#f4f1eaB0',
    '-pointsize', String(Math.floor(S * 0.044)),
    '-annotate', `+${pad}+${S - pad}`, album.artist,
    '-quality', '82',
    dest
  )
  execFileSync('magick', args)
}

// --- the hero: REAL art, and the only real art in the set --------------------
//
// Scene 1 is the one screenshot where a single cover fills the screen, and it is the frame a
// store browser judges first. Generated art is fine behind a grid at thumbnail size; it is thin
// blown up to full width. So the hero is a REAL album.
//
// It is the demo album the app already ships - `assets/demo-music`, CC0 1.0, provenance and two
// independent licence checks recorded in assets/demo-music/LICENSE.md. Deliberately that one and
// not something new: it adds NO third-party file to this repo, it is already vetted, and it is
// the album a new user actually hears on the "I don't have one yet" path. (CHILL FOR REAL! by
// the same artist was verified to the same standard on 2026-08-12 - artist's own page carries
// the CC-0 badge, archive.org item agrees - if a second real cover is ever wanted.)
//
// IT IS NOT IN `albums`, and that is the point. The real cover is bold cartoon art and the
// generated sleeves are muted minimal ones; side by side in a grid the pair reads as a mistake
// rather than as variety. Carrying it separately means scene 1 shows real art and the grid
// scenes stay internally coherent - which is also true of a real library, where the shelf and
// the record on the turntable need not match.
function hero () {
  const dir = path.join(__dirname, '..', 'assets', 'demo-music')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const cover = fs.readFileSync(path.join(dir, manifest.cover))
  const t = manifest.tracks[0]
  return {
    album: {
      id: 'fxhero',
      name: manifest.album,
      artist: manifest.artist,
      year: manifest.year,
      songCount: manifest.tracks.length,
      coverId: 'chero'
    },
    track: { title: t.title, artist: t.artist, durationMs: t.durationMs },
    cover: 'data:image/jpeg;base64,' + cover.toString('base64')
  }
}

// --- build -------------------------------------------------------------------
const albums = library(COUNT)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'peartune-fx-'))
fs.mkdirSync(OUT_DIR, { recursive: true })

const covers = {}
let bytes = 0
for (const a of albums) {
  const f = path.join(tmp, a.coverId + '.jpg')
  drawCover(a, f)
  const buf = fs.readFileSync(f)
  bytes += buf.length
  covers[a.coverId] = 'data:image/jpeg;base64,' + buf.toString('base64')
}

const h = hero()
covers[h.album.coverId] = h.cover
const out = { genre: 'Indie', albums, covers, hero: { album: h.album, track: h.track }, synthetic: true }
const dest = path.join(OUT_DIR, 'pack.json')
fs.writeFileSync(dest, JSON.stringify(out))
fs.rmSync(tmp, { recursive: true, force: true })

const kb = (n) => Math.round(n / 1024) + ' KB'
console.log(`${albums.length} invented albums, covers ${kb(bytes)} -> ${kb(fs.statSync(dest).size)} of JSON`)
console.log(dest)
