#!/usr/bin/env node
// Pack the captured library slice into the small JSON the app injects.
//
// scripts/screenshot-fixture.sh pulls the whole slice - 76 albums and ~32 MB of covers. That is
// far more than a screenshot needs and far too much to inject into a boot script, so this picks N
// albums and inlines their covers as data: URLs. Data URLs because the WebView has no host and no
// loopback shim in screenshot mode: an http art URL would simply fail to load, and a grid of
// broken images is a worse frame than no frame.
//
// Usage:
//   node scripts/screenshot-fixture-pack.js [count]      # default 18, enough to fill a grid
//
// Writes metadata/screenshot-fixtures/pack.json, which is gitignored along with everything else
// under that directory - the covers are real commercial album art.

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DIR = path.join(ROOT, 'metadata/screenshot-fixtures')
const COUNT = Number(process.argv[2]) || 18

const src = path.join(DIR, 'Synthwave.json')
if (!fs.existsSync(src)) {
  console.error(`no ${src} - run scripts/screenshot-fixture.sh first (it needs a paired, connected phone)`)
  process.exit(1)
}

const fixture = JSON.parse(fs.readFileSync(src, 'utf8'))
const covers = fs.readdirSync(path.join(DIR, 'covers'))

// Prefer the LARGEST cached size per coverId. The grid scales down cleanly; it cannot scale up,
// and a store screenshot is the one place softness shows.
const bySize = new Map()
for (const f of covers) {
  const [id, size] = f.split('@')
  const n = Number(size) || 0
  if (!bySize.has(id) || bySize.get(id).n < n) bySize.set(id, { f, n })
}

const picked = []
for (const a of fixture.albums) {
  if (picked.length >= COUNT) break
  const hit = a.coverId && bySize.get(a.coverId)
  if (!hit) continue // no cover means a hole in the grid; skip rather than ship a gap
  picked.push({ a, file: hit.f })
}

if (picked.length < COUNT) {
  console.warn(`only ${picked.length} of ${COUNT} albums have a cached cover`)
}
if (!picked.length) {
  console.error('no albums with covers - the fixture would be empty')
  process.exit(1)
}

const out = { genre: fixture.genre, albums: [], covers: {} }
let bytes = 0
for (const { a, file } of picked) {
  const buf = fs.readFileSync(path.join(DIR, 'covers', file))
  bytes += buf.length
  out.albums.push({ id: a.id, name: a.name, artist: a.artist, year: a.year, songCount: a.songCount, coverId: a.coverId })
  out.covers[a.coverId] = 'data:image/jpeg;base64,' + buf.toString('base64')
}

const dest = path.join(DIR, 'pack.json')
fs.writeFileSync(dest, JSON.stringify(out))
const kb = (n) => Math.round(n / 1024) + ' KB'
console.log(`${out.albums.length} albums, covers ${kb(bytes)} -> ${kb(fs.statSync(dest).size)} of JSON`)
console.log(dest)
