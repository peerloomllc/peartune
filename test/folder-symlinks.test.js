// Shortcuts in the library folder (issue #390).
//
// A person keeps their music on three disks and puts a link to each one inside
// /music. The host walked straight past all three and reported an empty library,
// because `readdir(dir, { withFileTypes: true })` describes the LINK and a link is
// neither isDirectory() nor isFile(). Rescan changed nothing and no log said why,
// which is the worst shape a bug can have: the files are visibly right there.
//
// Windows junctions arrive at the same code path as symlinks, so these tests cover
// them too. What they do NOT cover is a Windows .lnk shortcut - an ordinary file
// holding a binary record of a path, which nothing in the OS follows for us.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fsp = require('fs/promises')
const os = require('os')

const { FolderAdapter } = require('../host/adapters/folder')
const { browse, hasAudio } = require('../host/browse')
const { libraryId } = require('../protocol/ids')
const hcrypto = require('hypercore-crypto')

const MUSIC = path.join(__dirname, 'fixtures', 'music')
const SAMPLE = path.join(MUSIC, 'Untagged', 'mystery recording.mp3')
const LIB = libraryId(hcrypto.randomBytes(32))

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'pt-link-'))

// The smallest valid PNG, for the linked-cover case. Cheaper and more honest than
// hoping a fixture album happens to carry a loose image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64')

// Unprivileged Windows cannot create a symlink at all, so skipping there beats a
// red suite that says nothing about the code under test. Checked once, lazily.
let _links = null
async function links () {
  if (_links === null) {
    const d = await tmp()
    _links = await fsp.symlink(MUSIC, path.join(d, 'l'), 'junction').then(() => true, () =>
      fsp.symlink(MUSIC, path.join(d, 'l2')).then(() => true, () => false))
  }
  return _links
}
const noLinks = 'this user or filesystem cannot create symlinks'

async function scan (root) {
  const a = new FolderAdapter({ root, libraryId: LIB })
  await a.scan()
  return a
}

test('a LINKED album folder inside the library is scanned', async (t) => {
  if (!await links()) return t.skip(noLinks)
  const real = await tmp()
  await fsp.mkdir(path.join(real, 'Elsewhere'))
  await fsp.copyFile(SAMPLE, path.join(real, 'Elsewhere', 'song.mp3'))

  const root = await tmp()
  await fsp.symlink(path.join(real, 'Elsewhere'), path.join(root, 'Elsewhere'))

  const a = await scan(root)
  assert.equal(a.tracks.size, 1, 'the track behind the link must be in the library')
})

test('a LINKED track file inside the library is scanned', async (t) => {
  if (!await links()) return t.skip(noLinks)
  const real = await tmp()
  await fsp.copyFile(SAMPLE, path.join(real, 'song.mp3'))

  const root = await tmp()
  await fsp.symlink(path.join(real, 'song.mp3'), path.join(root, 'linked.mp3'))

  const a = await scan(root)
  assert.equal(a.tracks.size, 1)
})

test('a link pointing at an ANCESTOR does not hang the scan', async (t) => {
  if (!await links()) return t.skip(noLinks)
  const root = await tmp()
  await fsp.mkdir(path.join(root, 'Album'))
  await fsp.copyFile(SAMPLE, path.join(root, 'Album', 'song.mp3'))
  // The cycle: root/Album/loop -> root. Without the visited-set the walk would
  // recurse until the stack gave out.
  await fsp.symlink(root, path.join(root, 'Album', 'loop'))

  const a = await scan(root)
  assert.equal(a.tracks.size, 1, 'the song is counted exactly once, and the walk terminates')
})

test('two links to the SAME folder do not double up the library', async (t) => {
  if (!await links()) return t.skip(noLinks)
  const real = await tmp()
  await fsp.copyFile(SAMPLE, path.join(real, 'song.mp3'))

  const root = await tmp()
  await fsp.symlink(real, path.join(root, 'a'))
  await fsp.symlink(real, path.join(root, 'b'))

  const a = await scan(root)
  assert.equal(a.tracks.size, 1)
})

test('a DANGLING link is ignored, and the rest of the library still scans', async (t) => {
  if (!await links()) return t.skip(noLinks)
  const root = await tmp()
  await fsp.copyFile(SAMPLE, path.join(root, 'real.mp3'))
  await fsp.symlink(path.join(root, 'gone-forever'), path.join(root, 'ghost.mp3'))
  await fsp.symlink(path.join(root, 'no-such-dir'), path.join(root, 'ghostdir'))

  const a = await scan(root)
  assert.equal(a.tracks.size, 1, 'a link to a deleted file is nothing to play, not a failed scan')
})

test('a LINKED cover.jpg is found', async (t) => {
  if (!await links()) return t.skip(noLinks)
  const real = await tmp()
  await fsp.writeFile(path.join(real, 'cover.jpg'), PNG)

  const root = await tmp()
  await fsp.copyFile(SAMPLE, path.join(root, 'song.mp3'))
  await fsp.symlink(path.join(real, 'cover.jpg'), path.join(root, 'cover.jpg'))

  const a = await scan(root)
  const found = await a._coverFile(root)
  assert.equal(found, path.join(root, 'cover.jpg'))
})

test('the folder PICKER shows a linked folder, and marks that it holds music', async (t) => {
  if (!await links()) return t.skip(noLinks)
  const real = await tmp()
  await fsp.copyFile(SAMPLE, path.join(real, 'song.mp3'))

  const root = await tmp()
  await fsp.symlink(real, path.join(root, 'MyMusic'))

  const listing = await browse(root)
  const kid = listing.dirs.find(d => d.name === 'MyMusic')
  assert.ok(kid, 'a linked folder must be offered to the operator at all')
  assert.equal(kid.music, true, 'and must be marked as holding music')
})

test('the picker counts a linked track sitting in the folder you are standing in', async (t) => {
  if (!await links()) return t.skip(noLinks)
  const real = await tmp()
  await fsp.copyFile(SAMPLE, path.join(real, 'song.mp3'))

  const root = await tmp()
  await fsp.symlink(path.join(real, 'song.mp3'), path.join(root, 'here.mp3'))

  assert.equal((await browse(root)).here, 1)
  assert.equal(await hasAudio(root), true)
})
