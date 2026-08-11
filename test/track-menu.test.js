// Every list of tracks must offer the long-press menu (GitHub #199).
//
// WHY THIS EXISTS: the action sheet has handled `{ type: 'track' }` since it was written, and
// `Row` has taken an `onLong` prop just as long. The bug Tim reported was never a missing
// FEATURE - it was three track lists that simply never passed the prop. Long-pressing a track
// inside an album, a download or a playlist did nothing at all, while the identical row inside
// an artist or a genre opened the menu.
//
// That is a wiring gap, and wiring gaps do not fail loudly: nothing throws, nothing logs, the
// row just sits there. It also comes back every time somebody adds a new screen with a track
// list, which is why this is a test and not a fixed diff.
//
// SO: read the source and require an `onLong` on every <Row>. Deliberately crude - it proves
// the prop is passed, not that the menu opens - but it is exactly the class of mistake that
// shipped, and it costs nothing.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.jsx'), 'utf8')

// Each <Row ... /> element, as source text.
function rowElements (src) {
  const out = []
  let i = 0
  for (;;) {
    const start = src.indexOf('<Row', i)
    if (start === -1) return out
    const end = src.indexOf('/>', start)
    assert.notEqual(end, -1, 'a <Row> with no self-closing tag - this test cannot read it')
    out.push({ text: src.slice(start, end + 2), line: src.slice(0, start).split('\n').length })
    i = end + 2
  }
}

test('every track row offers the long-press menu', () => {
  const rows = rowElements(SRC)
  assert.ok(rows.length >= 9, `only ${rows.length} track rows found - has Row been renamed?`)
  const missing = rows.filter(r => !r.text.includes('onLong')).map(r => `App.jsx:${r.line}`)
  assert.deepEqual(missing, [], 'these track lists cannot open the menu on long-press')
})

test('the screens holding those rows take an onLong of their own', () => {
  // The other half of the same gap: a Row can pass `onLong={onLong}` and still do nothing if
  // its screen never declared the prop, because undefined is a perfectly quiet no-op.
  for (const screen of ['AlbumScreen', 'DownloadScreen', 'PlaylistScreen', 'ArtistScreen', 'GenreScreen']) {
    const sig = new RegExp(`function ${screen} \\(\\{([^}]*)\\}`).exec(SRC)
    assert.ok(sig, `${screen} is gone or no longer takes a props object`)
    assert.match(sig[1], /\bonLong\b/, `${screen} does not accept onLong`)
  }
})

test('the action sheet still handles a single track', () => {
  // What the rows above are wired TO. One track cannot be shuffled, so that button is hidden
  // rather than offered as a no-op - if that guard goes, the menu grows a dead button.
  assert.match(SRC, /item\.type !== 'track' && \(/, 'the shuffle guard for a single track is gone')
  assert.match(SRC, /onLong\(\{ type: 'track', track: t, name: t\.title \}\)/, 'Row no longer raises a track menu')
})
