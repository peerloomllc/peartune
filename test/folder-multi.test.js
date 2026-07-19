// The folder adapter pointed at MORE THAN ONE directory.
//
// The load-bearing property is trackId behaviour: the PRIMARY (first) root keeps the
// exact ids a single-root library had - so adding a second folder does not orphan a
// person's favourites/resume/counts - while files under other roots get unique ids
// even when two roots share a directory layout.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fsp = require('fs/promises')
const os = require('os')

const { FolderAdapter, normalizeRoots } = require('../host/adapters/folder')
const { libraryId } = require('../protocol/ids')
const hcrypto = require('hypercore-crypto')

const MUSIC = path.join(__dirname, 'fixtures', 'music')
const SAMPLE = path.join(MUSIC, 'Untagged', 'mystery recording.mp3')
const LIB = libraryId(hcrypto.randomBytes(32))

const idsOf = (a) => new Set([...a.tracks.values()].map(t => t.id))

async function tmpWith (relFiles) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-multi-'))
  for (const rel of relFiles) {
    const abs = path.join(d, rel)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.copyFile(SAMPLE, abs)
  }
  return d
}

test('the primary root keeps the SAME trackIds as a single-root library (no orphaning)', async () => {
  const single = new FolderAdapter({ root: MUSIC, libraryId: LIB })
  await single.scan()

  const multi = new FolderAdapter({ roots: [MUSIC, await tmpWith(['b/extra.mp3'])], libraryId: LIB })
  await multi.scan()

  // Every id the single-root scan produced still exists in the multi-root scan.
  for (const id of idsOf(single)) {
    assert.ok(idsOf(multi).has(id), 'primary-root ids must be unchanged when a folder is added')
  }
})

test('a second root ADDS its tracks; ids are unique across roots', async () => {
  const single = new FolderAdapter({ root: MUSIC, libraryId: LIB })
  await single.scan()
  const base = single.tracks.size

  const b = await tmpWith(['Album/one.mp3', 'Album/two.mp3'])
  const multi = new FolderAdapter({ roots: [MUSIC, b], libraryId: LIB })
  await multi.scan()

  assert.equal(multi.tracks.size, base + 2, 'both new files show up')
  assert.equal(idsOf(multi).size, multi.tracks.size, 'no duplicate ids')
})

test('two roots with the SAME relative path do not collide', async () => {
  const a = await tmpWith(['Album/song.mp3'])
  const b = await tmpWith(['Album/song.mp3']) // identical layout, different root
  const adapter = new FolderAdapter({ roots: [a, b], libraryId: LIB })
  await adapter.scan()

  assert.equal(adapter.tracks.size, 2, 'both files present')
  assert.equal(idsOf(adapter).size, 2, 'two distinct ids, not one collision')
})

test('a folder nested inside another is not scanned twice', async () => {
  const outer = await tmpWith(['top.mp3', 'sub/inner.mp3'])
  const inner = path.join(outer, 'sub')
  const adapter = new FolderAdapter({ roots: [outer, inner], libraryId: LIB })
  await adapter.scan()
  assert.equal(adapter.tracks.size, 2, 'inner.mp3 counted once, not twice')
  assert.deepEqual(adapter.roots, [path.resolve(outer)], 'the nested root is dropped')
})

test('normalizeRoots: resolves, de-dupes, drops nested, keeps order', () => {
  assert.deepEqual(normalizeRoots(['/music', '/music']), [path.resolve('/music')])
  assert.deepEqual(
    normalizeRoots(['/music', '/audiobooks']),
    [path.resolve('/music'), path.resolve('/audiobooks')],
    'order preserved so the primary stays primary'
  )
  assert.deepEqual(normalizeRoots(['/music', '/music/sub']), [path.resolve('/music')], 'nested dropped')
  assert.deepEqual(normalizeRoots(['', null, '/music']), [path.resolve('/music')], 'blanks ignored')
})
