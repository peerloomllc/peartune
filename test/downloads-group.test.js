// Downloading an artist or a genre, which is a LOOP OVER ALBUMS rather than a pin of its own.
//
// WHY THESE EXIST: a group download has no state in the worklet - `pins` is keyed by album id
// and always has been. Everything a user sees about a group ("Download", "Download 3 more",
// "Downloaded", "4/12 albums") is DERIVED from its albums, every render. That derivation is
// exactly the kind of thing that looks right in a screenshot and is wrong in the cases nobody
// opens: the artist that is half downloaded, the genre with no albums at all, the second
// artist whose button must not show the first artist's spinner.
//
// Tim asked for the confirmation (2026-08-11) because a genre can be most of a library, so the
// count in that prompt is a promise about what is about to be fetched. It counts what is
// MISSING, not the size of the group - that is pinned here too.

const test = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/ui/downloads.js')

const ARTIST = { name: 'Metallica', albums: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] }

test('the album ids behind a group, deduped, in order', async () => {
  const { albumIdsOf } = await load()
  assert.deepEqual(albumIdsOf(ARTIST), ['a1', 'a2', 'a3'])
  assert.deepEqual(albumIdsOf({ albums: [{ id: 'x' }, { id: 'x' }, { id: 'y' }] }), ['x', 'y'])
})

test('loose tracks are not album ids, because nothing can pin them', async () => {
  // An artist of one-off tracks with no album of its own. Pins are album-keyed, so there is
  // genuinely nothing to download - and the button renders nothing rather than lying.
  const { albumIdsOf, groupDownloadState } = await load()
  const loose = { name: 'Various', albums: [], tracks: [{ id: 't1' }, { id: 't2' }] }
  assert.deepEqual(albumIdsOf(loose), [])
  assert.equal(groupDownloadState({ albumIds: [], pinned: new Set() }).kind, 'empty')
})

test('a group with nothing downloaded offers the whole thing', async () => {
  const { groupDownloadState } = await load()
  const st = groupDownloadState({ albumIds: ['a1', 'a2', 'a3'], pinned: new Set() })
  assert.equal(st.kind, 'none')
  assert.equal(st.total, 3)
  assert.deepEqual(st.pending, ['a1', 'a2', 'a3'])
})

test('a half-downloaded group offers only what is missing', async () => {
  // The case that would otherwise re-stream bytes we are already holding.
  const { groupDownloadState } = await load()
  const st = groupDownloadState({ albumIds: ['a1', 'a2', 'a3'], pinned: new Set(['a2']) })
  assert.equal(st.kind, 'partial')
  assert.equal(st.done, 1)
  assert.equal(st.total, 3)
  assert.deepEqual(st.pending, ['a1', 'a3'])
})

test('a fully downloaded group turns into a remove', async () => {
  const { groupDownloadState } = await load()
  const st = groupDownloadState({ albumIds: ['a1', 'a2'], pinned: new Set(['a1', 'a2']) })
  assert.equal(st.kind, 'downloaded')
  assert.deepEqual(st.pending, [])
})

test('the spinner belongs to ONE group, not to every screen', async () => {
  // Two artists open in a nav stack, one downloading. Without the key check the other one
  // would show a progress count for albums that have nothing to do with it.
  const { groupDownloadState } = await load()
  const active = { key: 'artist:1', done: 4, total: 12 }
  const mine = groupDownloadState({ albumIds: ['a1'], pinned: new Set(), active, key: 'artist:1' })
  assert.equal(mine.kind, 'downloading')
  assert.equal(mine.done, 4)
  assert.equal(mine.total, 12)

  const theirs = groupDownloadState({ albumIds: ['b1'], pinned: new Set(), active, key: 'artist:2' })
  assert.equal(theirs.kind, 'none', 'another group must not wear this one\'s spinner')
})

test('pendingDownloads takes a Set or a plain map', async () => {
  const { pendingDownloads } = await load()
  assert.deepEqual(pendingDownloads(['a', 'b'], new Set(['a'])), ['b'])
  assert.deepEqual(pendingDownloads(['a', 'b'], { a: true }), ['b'])
  assert.deepEqual(pendingDownloads(['a'], null), ['a'])
})

test('the prompt counts what will be FETCHED, not the size of the group', async () => {
  // Nine of twelve already here: "Download 12 albums?" would be a lie about someone's data.
  const { downloadPrompt, groupDownloadState } = await load()
  const albumIds = Array.from({ length: 12 }, (_, i) => 'a' + i)
  const pinned = new Set(albumIds.slice(0, 9))
  const st = groupDownloadState({ albumIds, pinned })
  const p = downloadPrompt({ name: 'Metallica', count: st.pending.length })
  assert.match(p.title, /Download Metallica\?/)
  assert.match(p.body, /^3 albums/)
  assert.equal(p.yes, 'Download')
})

test('one album is an album, not "1 albums"', async () => {
  const { downloadPrompt, removePrompt } = await load()
  assert.match(downloadPrompt({ name: 'X', count: 1 }).body, /1 album will/)
  assert.match(removePrompt({ name: 'X', count: 1 }).body, /1 downloaded album from X/)
})

test('removing says the library keeps the music, and is marked destructive', async () => {
  const { removePrompt } = await load()
  const p = removePrompt({ name: 'Ambient', count: 4 })
  assert.equal(p.danger, true)
  assert.equal(p.yes, 'Remove')
  assert.match(p.body, /library keeps them/i)
})
