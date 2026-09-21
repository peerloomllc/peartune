// Lyrics (proposal 2026-09-21): the parsers, the three adapters that can read words,
// and the method/cap wiring that decides whether the phone ever asks.
//
// The parsers get the most attention because they are what a stranger's .lrc lands in:
// the timestamp forms, the offset tag, the half-timed file, the enormous file. Anything
// that gets through here ends up scrolling past someone's eyes in time with the music.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const hcrypto = require('hypercore-crypto')

const { parseLrc, parsePlain, fromTimedLines, MAX_LINES } = require('../host/lyrics')
const { METHODS, MUTATING } = require('../host/media')
const { SubsonicAdapter } = require('../host/adapters/subsonic')
const { JellyfinAdapter } = require('../host/adapters/jellyfin')
const { FolderAdapter } = require('../host/adapters/folder')
const { libraryId } = require('../protocol/ids')

const lib = libraryId(hcrypto.keyPair().publicKey)

// --- the .lrc parser --------------------------------------------------------

test('a plain .lrc: timestamps become ms, and the lines come back in time order', () => {
  const got = parseLrc('[00:12.34]second\n[00:01.00]first\n[01:00]third\n')
  assert.equal(got.synced, true)
  assert.deepEqual(got.lines, [
    { t: 1000, text: 'first' },
    { t: 12340, text: 'second' },
    { t: 60000, text: 'third' }
  ])
})

test('two-digit hundredths and three-digit milliseconds both work', () => {
  assert.equal(parseLrc('[00:01.5]x').lines[0].t, 1500, '.5 is half a second, not five milliseconds')
  assert.equal(parseLrc('[00:01.05]x').lines[0].t, 1050)
  assert.equal(parseLrc('[00:01.050]x').lines[0].t, 1050)
})

test('several timestamps on one line repeat the words - that is how a chorus is written', () => {
  const got = parseLrc('[00:10.00][01:10.00][02:10.00]chorus')
  assert.deepEqual(got.lines.map(l => l.t), [10000, 70000, 130000])
  assert.ok(got.lines.every(l => l.text === 'chorus'))
})

test('metadata tags are dropped, and [offset:] shifts every line', () => {
  const got = parseLrc('[ar:Someone]\n[ti:A song]\n[offset:+500]\n[00:10.00]late\n')
  assert.deepEqual(got.lines, [{ t: 9500, text: 'late' }], 'a positive offset pulls the words EARLIER')
  const back = parseLrc('[offset:-500]\n[00:10.00]early\n')
  assert.equal(back.lines[0].t, 10500)
})

test('a PARTLY timed file is served unsynced rather than jumping the highlight around', () => {
  const got = parseLrc('[00:01.00]timed\nuntimed line\n[00:02.00]timed again\n')
  assert.equal(got.synced, false, 'one untimed line drops the whole track to plain text')
  assert.ok(got.lines.every(l => l.t === null))
  assert.deepEqual(got.lines.map(l => l.text), ['timed', 'untimed line', 'timed again'])
})

test('text with no timestamps at all is words, not nothing', () => {
  const got = parseLrc('just some words\nand more')
  assert.equal(got.synced, false)
  assert.equal(got.lines.length, 2)
})

test('an empty stamped line is KEPT - it is the gap between verses', () => {
  const got = parseLrc('[00:01.00]a\n[00:05.00]\n[00:09.00]b\n')
  assert.deepEqual(got.lines.map(l => l.text), ['a', '', 'b'])
})

test('blank lines at the ends are trimmed, and nothing at all is an empty result', () => {
  assert.deepEqual(parseLrc('\n\n[00:01.00]\n[00:02.00]a\n[00:03.00]\n').lines, [{ t: 2000, text: 'a' }])
  assert.deepEqual(parseLrc('   \n\n').lines, [])
  assert.deepEqual(parseLrc('').lines, [])
  assert.deepEqual(parseLrc(null).lines, [])
})

test('a huge file is truncated, not thrown - some words beat none, and the phone may be on cellular', () => {
  const many = Array.from({ length: MAX_LINES + 500 }, (_, i) => `[00:${String(i % 60).padStart(2, '0')}.00]line${i}`).join('\n')
  const got = parseLrc(many)
  assert.equal(got.lines.length, MAX_LINES)
})

test('a time the offset pushes below zero is clamped there, and a day is the ceiling', () => {
  assert.equal(parseLrc('[offset:99999999]\n[00:01.00]x').lines[0].t, 0, 'never negative')
  // 999 minutes is a legal .lrc stamp and under the ceiling, so it passes through.
  assert.equal(parseLrc('[999:59.99]x').lines[0].t, 999 * 60000 + 59990)
  // The ceiling is reachable from a source that hands us its own numbers.
  assert.equal(fromTimedLines([{ t: 99 * 60 * 60 * 1000, text: 'x' }]).lines[0].t, 24 * 60 * 60 * 1000)
})

// --- the other two shapes ---------------------------------------------------

test('parsePlain keeps the line breaks and times nothing', () => {
  const got = parsePlain('one\ntwo\n')
  assert.equal(got.synced, false)
  assert.deepEqual(got.lines, [{ t: null, text: 'one' }, { t: null, text: 'two' }])
})

test('fromTimedLines sorts, and an entry with no time drops the whole thing to unsynced', () => {
  assert.deepEqual(fromTimedLines([{ t: 20, text: 'b' }, { t: 10, text: 'a' }]).lines,
    [{ t: 10, text: 'a' }, { t: 20, text: 'b' }])
  assert.equal(fromTimedLines([{ t: 10, text: 'a' }, { t: null, text: 'b' }]).synced, false)
  assert.deepEqual(fromTimedLines(null).lines, [])
})

// --- the Subsonic adapter ---------------------------------------------------

function stubFetch (t, routes) {
  const seen = []
  const real = global.fetch
  t.after(() => { global.fetch = real })
  global.fetch = async (url) => {
    const u = String(url)
    seen.push(u)
    for (const [needle, body] of routes) {
      if (u.includes(needle)) {
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
      }
    }
    return { ok: true, status: 200, json: async () => ({ 'subsonic-response': { status: 'ok' } }), text: async () => '{}' }
  }
  return seen
}

const subsonic = () => {
  const a = new SubsonicAdapter({ url: 'http://nav:4533/', username: 'u', password: 'p', libraryId: lib })
  a._songId = async () => 'song1'
  return a
}

test('subsonic: OpenSubsonic structuredLyrics with timings comes back synced', async (t) => {
  stubFetch(t, [['getLyricsBySongId', {
    'subsonic-response': {
      status: 'ok',
      lyricsList: {
        structuredLyrics: [{
          synced: true,
          offset: 100,
          line: [{ start: 1000, value: 'first' }, { start: 2000, value: 'second' }]
        }]
      }
    }
  }]])

  const got = await subsonic().lyrics({ trackId: 'ours' })
  assert.equal(got.synced, true)
  assert.deepEqual(got.lines, [{ t: 1100, text: 'first' }, { t: 2100, text: 'second' }],
    "structuredLyrics' own offset is ADDED, unlike an .lrc tag which is subtracted")
})

test('subsonic: a synced entry is preferred when several languages come back', async (t) => {
  stubFetch(t, [['getLyricsBySongId', {
    'subsonic-response': {
      status: 'ok',
      lyricsList: {
        structuredLyrics: [
          { synced: false, line: [{ value: 'plain' }] },
          { synced: true, line: [{ start: 500, value: 'timed' }] }
        ]
      }
    }
  }]])

  const got = await subsonic().lyrics({ trackId: 'ours' })
  assert.equal(got.synced, true)
  assert.equal(got.lines[0].text, 'timed')
})

test('subsonic: no OpenSubsonic endpoint falls back to classic getLyrics by artist+title', async (t) => {
  const seen = stubFetch(t, [
    ['getLyricsBySongId', { 'subsonic-response': { status: 'failed', error: { code: 30, message: 'not supported' } } }],
    ['getSong', { 'subsonic-response': { status: 'ok', song: { id: 'song1', title: 'A Song', artist: 'A Band' } } }],
    ['getLyrics', { 'subsonic-response': { status: 'ok', lyrics: { value: 'line one\nline two' } } }]
  ])

  const got = await subsonic().lyrics({ trackId: 'ours' })
  assert.equal(got.synced, false)
  assert.deepEqual(got.lines.map(l => l.text), ['line one', 'line two'])
  const classic = seen.find(u => u.includes('getLyrics.view') || (u.includes('getLyrics') && !u.includes('BySongId')))
  assert.ok(classic.includes('artist=A%20Band') || classic.includes('artist=A+Band'), 'the artist went with it')
})

test('subsonic: a server with no lyrics at all answers null, not an error', async (t) => {
  stubFetch(t, [
    ['getLyricsBySongId', { 'subsonic-response': { status: 'failed', error: { code: 30 } } }],
    ['getSong', { 'subsonic-response': { status: 'ok', song: { id: 'song1', title: 'A Song' } } }],
    ['getLyrics', { 'subsonic-response': { status: 'ok', lyrics: {} } }]
  ])
  assert.equal(await subsonic().lyrics({ trackId: 'ours' }), null)
})

// --- the Jellyfin adapter ---------------------------------------------------

const jellyfin = () => {
  const a = new JellyfinAdapter({ url: 'http://jf:8096/', username: 'u', password: 'p', libraryId: lib })
  a.token = 'T'; a.userId = 'u'
  a._auth = async () => {}
  a._itemId = async () => 'item1'
  return a
}

test('jellyfin: Start is in TICKS and becomes milliseconds', async (t) => {
  stubFetch(t, [['/Lyrics', { Lyrics: [{ Start: 15000000, Text: 'a' }, { Start: 30000000, Text: 'b' }] }]])
  const got = await jellyfin().lyrics({ trackId: 'ours' })
  assert.equal(got.synced, true)
  assert.deepEqual(got.lines, [{ t: 1500, text: 'a' }, { t: 3000, text: 'b' }],
    '10,000 ticks per millisecond')
})

test('jellyfin: an unsynced file has no Start at all and comes back as plain words', async (t) => {
  stubFetch(t, [['/Lyrics', { Lyrics: [{ Text: 'a' }, { Text: 'b' }] }]])
  const got = await jellyfin().lyrics({ trackId: 'ours' })
  assert.equal(got.synced, false)
  assert.deepEqual(got.lines.map(l => l.text), ['a', 'b'])
})

test('jellyfin: a 404 (no words for this song) is null, not a throw', async (t) => {
  const real = global.fetch
  t.after(() => { global.fetch = real })
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
  assert.equal(await jellyfin().lyrics({ trackId: 'ours' }), null)
})

// --- the folder adapter -----------------------------------------------------

test('folder: an .lrc beside the file wins, and a missing one is not an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-lyrics-'))
  const song = path.join(dir, 'song.mp3')
  fs.writeFileSync(song, 'not really an mp3')
  fs.writeFileSync(path.join(dir, 'song.lrc'), '[00:02.00]beside the file\n')

  const a = new FolderAdapter({ root: dir, libraryId: lib })
  a.tracks = new Map([['t1', { absPath: song }]])

  const got = await a.lyrics({ trackId: 't1' })
  assert.equal(got.synced, true)
  assert.deepEqual(got.lines, [{ t: 2000, text: 'beside the file' }])

  // A track we do not hold is null, and so is one whose file has neither an .lrc
  // nor a readable tag (this one is not really an mp3).
  assert.equal(await a.lyrics({ trackId: 'nope' }), null)
  a.tracks.set('t2', { absPath: path.join(dir, 'other.mp3') })
  fs.writeFileSync(path.join(dir, 'other.mp3'), 'still not an mp3')
  assert.equal(await a.lyrics({ trackId: 't2' }), null)

  fs.rmSync(dir, { recursive: true, force: true })
})

// --- the wiring -------------------------------------------------------------

test('lyrics.get is a method, and is NOT mutating - a readonly grant may read words', () => {
  assert.ok(METHODS.includes('lyrics.get'), 'the host must answer lyrics.get')
  assert.ok(!MUTATING.has('lyrics.get'), 'reading lyrics writes nothing')
})

test('the cap is what hides the button, and it follows the adapter', () => {
  const media = fs.readFileSync(path.join(__dirname, '..', 'host', 'media.js'), 'utf8')
  assert.match(media, /typeof getAdapter\(\)\?\.lyrics === 'function' \? \{ lyrics: 1 \}/,
    'ping must advertise lyrics only when the live adapter can actually read them')

  const bare = fs.readFileSync(path.join(__dirname, '..', 'src', 'bare.js'), 'utf8')
  assert.match(bare, /capsFor\([^)]*\)\)\.lyrics/, 'the phone must check the cap before asking')

  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.jsx'), 'utf8')
  assert.match(ui, /lyrics\?\.supported && lyrics\.lines\?\.length > 0/,
    'no Lyrics button unless the host said yes AND there are words')
  // play:started names the track `trackId`; the queue and library rows call the same
  // thing `id`. Reading `now.id` here fails SILENTLY - the effect never runs and no
  // button ever appears - which is exactly how this shipped broken the first time.
  assert.match(ui, /const tid = now\?\.trackId/,
    'the lyrics fetch must read now.trackId, never now.id')
  assert.ok(!/lyrics\?\.trackId === now\??\.id\b/.test(ui), 'now.id is undefined on a now-playing record')
})
