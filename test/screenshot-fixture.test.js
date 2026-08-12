// The SYNTHETIC screenshot library - the one that can be regenerated on any checkout.
//
// WHY IT EXISTS (2026-08-12): the first Zapstore listing went up with no screenshots at all.
// Not a broken release script and not a missing credential - `zapstore.yaml` simply has no
// `images:` block, because the only screenshots that existed render REAL commercial album art
// out of Tim's own library. That art cannot go in a public MIT repo, so the captures are
// gitignored, so a config in that repo cannot point at them. Nothing to upload.
//
// scripts/make-screenshot-fixture.js removes the cause: it INVENTS the library. These tests
// pin the three properties that make that fixture safe to ship a store listing from.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'make-screenshot-fixture.js')
// A DISPOSABLE OUTPUT DIR. These tests used to write to the real fixture path, so running the
// suite left metadata/screenshot-fixtures/pack.json holding whatever the last test asked for -
// and the next store capture silently shot that instead of the intended library.
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'peartune-fixture-test-'))

const build = (n = 6) => {
  execFileSync('node', [SCRIPT, String(n)], { stdio: 'pipe', env: { ...process.env, PEARTUNE_FIXTURE_OUT: OUT } })
  return JSON.parse(fs.readFileSync(path.join(OUT, 'pack.json'), 'utf8'))
}

// ImageMagick draws the covers. On a machine without it there is nothing to test and nothing
// to fix, so skip rather than fail the whole gate for a tool the app itself never needs.
let haveMagick = true
try { execFileSync('magick', ['-version'], { stdio: 'pipe' }) } catch { haveMagick = false }

test('the fixture is invented - no real artist, album or artwork in the grid', { skip: !haveMagick && 'ImageMagick not installed' }, () => {
  const p = build(12)
  assert.equal(p.synthetic, true, 'it must say so, so nobody mistakes it for a real snapshot')
  assert.equal(p.albums.length, 12)
  for (const a of p.albums) {
    assert.ok(a.name && a.artist && a.coverId)
    assert.ok(p.covers[a.coverId].startsWith('data:image/jpeg;base64,'), 'covers ride inline - a screenshot build has no host to fetch from')
  }
  // Every cover is drawn by the script, so no two albums may share one: a shared coverId would
  // mean a grid of duplicates, and would hint that art came from somewhere else.
  const ids = p.albums.map(a => a.coverId)
  assert.equal(new Set(ids).size, ids.length, 'covers must be unique per album')
})

test('THE SAME SEED GIVES THE SAME LIBRARY', { skip: !haveMagick && 'ImageMagick not installed' }, () => {
  // The point of generating rather than committing: a contributor on a clean checkout has to be
  // able to reproduce the shipped screenshots exactly, not something that merely looks similar.
  const a = build(8)
  const b = build(8)
  assert.deepEqual(a.albums, b.albums, 'album metadata drifted between runs')
  for (const id of Object.keys(a.covers)) {
    assert.equal(a.covers[id], b.covers[id], `cover ${id} is not byte-identical between runs`)
  }
})

test('THE REAL COVER IS THE HERO AND IS NEVER IN THE GRID', { skip: !haveMagick && 'ImageMagick not installed' }, () => {
  // Scene 1 shows one cover at full width, where generated art is thin - so it uses the demo
  // album the app already ships (CC0, vetted in assets/demo-music/LICENSE.md). That cover is
  // bold cartoon art and the generated sleeves are muted minimal ones; in a grid together the
  // pair reads as a mistake. Carrying the hero OUTSIDE `albums` is what keeps them apart.
  const p = build(10)
  assert.ok(p.hero && p.hero.album, 'no hero: scene 1 would fall back to generated art')
  assert.equal(p.hero.album.artist, 'Loyalty Freak Music')
  assert.ok(p.covers[p.hero.album.coverId], 'the hero cover has to be in the cover map')
  assert.equal(
    p.albums.some(a => a.id === p.hero.album.id || a.coverId === p.hero.album.coverId), false,
    'the hero leaked into the grid - real and generated art would appear side by side'
  )
})

test('album titles are English, not a cartesian product', { skip: !haveMagick && 'ImageMagick not installed' }, () => {
  // The first cut paired one qualifier list with one noun list and produced "Every Gardens" and
  // "Half Mornings". A store screenshot full of not-quite-English is worse than a plain one.
  const p = build(24)
  const singular = ['Every', 'Another', 'The Last', 'Second', 'First', 'No Ordinary', 'The Quiet', 'One More', 'The Longest']
  const plurals = /(?:Fronts|Rooms|Machines|Harbours|Summers|Letters|Stations|Mornings|Winters|Distances|Signals|Gardens|Cities)$/
  for (const a of p.albums) {
    const lead = singular.find(s => a.name.startsWith(s + ' '))
    if (lead) assert.ok(!plurals.test(a.name), `"${a.name}" pairs a singular qualifier with a plural noun`)
  }
})
