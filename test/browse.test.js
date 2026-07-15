// The folder picker's backend.
//
// It exists because the folder path is a path INSIDE the container, and a free-text
// box the host cannot verify is how an operator ends up typing their NAS's path,
// getting zero tracks, and concluding the app is broken. So the dashboard lists what
// the container CAN see, and this is what it lists from.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')

const { browse, hasAudio } = require('../host/browse')

async function tree (t) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-browse-'))
  t.after(() => fsp.rm(d, { recursive: true, force: true }))
  await fsp.mkdir(path.join(d, 'Music', 'Album'), { recursive: true })
  await fsp.mkdir(path.join(d, 'Documents'), { recursive: true })
  await fsp.mkdir(path.join(d, '.hidden'), { recursive: true })
  await fsp.writeFile(path.join(d, 'Music', 'Album', 'song.mp3'), 'x')
  await fsp.writeFile(path.join(d, 'Documents', 'notes.txt'), 'x')
  return d
}

test('browse lists directories, flags which ones hold music', async (t) => {
  const d = await tree(t)
  const r = await browse(d)

  assert.equal(r.path, d)
  const names = r.dirs.map(x => x.name)
  assert.ok(names.includes('Music'))
  assert.ok(names.includes('Documents'))
  assert.ok(!names.includes('.hidden'), 'dotfiles are noise')

  assert.equal(r.dirs.find(x => x.name === 'Music').music, true, 'music is somewhere under here')
  assert.equal(r.dirs.find(x => x.name === 'Documents').music, false)
})

test('browse never lists files - only directories', async (t) => {
  const d = await tree(t)
  const r = await browse(path.join(d, 'Documents'))
  assert.deepEqual(r.dirs, [], 'notes.txt is a file, not a browsable folder')
})

test('browse counts audio sitting directly in a folder', async (t) => {
  const d = await tree(t)
  const r = await browse(path.join(d, 'Music', 'Album'))
  assert.equal(r.here, 1, 'so "Use this folder" is meaningful when you are in the album')
})

test('browse offers a parent, except at the root', async (t) => {
  const d = await tree(t)
  assert.equal((await browse(d)).parent, path.dirname(d))
  assert.equal((await browse('/')).parent, null)
})

test('a path that does not exist is an ERROR, not an empty listing', async () => {
  await assert.rejects(browse('/definitely/not/here'), /does not exist inside the PearTune container/)
})

test('a file where a folder should be is an error', async (t) => {
  const d = await tree(t)
  await assert.rejects(browse(path.join(d, 'Documents', 'notes.txt')), /is a file, not a folder/)
})

test('hasAudio finds music nested a few levels down, and stops early', async (t) => {
  const d = await tree(t)
  assert.equal(await hasAudio(path.join(d, 'Music')), true)
  assert.equal(await hasAudio(path.join(d, 'Documents')), false)
})
