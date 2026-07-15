// Let the operator PICK a folder instead of typing one.
//
// THE BUG THIS EXISTS FOR. The folder path is a path INSIDE THE CONTAINER, and
// nothing said so. Tim typed the path his Navidrome uses - the one he can see on the
// Umbrel, /home/umbrel/umbrel/home/Downloads/music - and got zero tracks. Correctly:
// that path does not exist in the container. Only what is MOUNTED exists (/music).
// But "0 tracks" is indistinguishable from an empty library, so it reads as "this
// app is broken" rather than "that path is wrong". It cost an evening.
//
// A free-text box the host cannot verify is the problem. So: the dashboard shows the
// folders the container CAN see, the operator clicks one, and the box is filled in
// from something that provably exists. Typing still works, and now it fails loudly
// (the adapter throws with the list of what IS visible) instead of silently.
//
// This is a listing of the CONTAINER's filesystem, behind the dashboard password.
// It lists directory NAMES only - never files, never contents. The operator owns
// this box; they are allowed to see where their disks are mounted.

const fsp = require('fs/promises')
const path = require('path')

const { AUDIO_EXT, visibleMounts } = require('./adapters/folder')

// Bounded, because a browse click must never turn into a walk of a 4TB disk. Both
// caps are per DIRECTORY we report on, and hitting either just means we stop looking
// - "we found music in there" is a yes/no question and we can answer it early.
const PROBE_MAX_ENTRIES = 4000
const PROBE_MAX_DEPTH = 4

const isAudio = (name) => AUDIO_EXT.has(path.extname(name).toLowerCase())

// Does this directory contain music, anywhere under it? Stops at the FIRST hit.
async function hasAudio (dir, budget = { entries: PROBE_MAX_ENTRIES }, depth = 0) {
  if (depth > PROBE_MAX_DEPTH || budget.entries <= 0) return false

  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }

  const subdirs = []
  for (const e of entries) {
    if (budget.entries-- <= 0) return false
    if (e.name.startsWith('.')) continue
    if (e.isFile() && isAudio(e.name)) return true // early exit: that is the question
    if (e.isDirectory()) subdirs.push(path.join(dir, e.name))
  }

  for (const sub of subdirs) {
    if (await hasAudio(sub, budget, depth + 1)) return true
  }
  return false
}

// One level of the tree, with a "has music" flag on each child so the operator can
// see which branch is theirs without opening every one.
async function browse (target = '/') {
  const dir = path.resolve(target || '/')

  let st
  try {
    st = await fsp.stat(dir)
  } catch {
    const e = new Error(`${dir} does not exist inside the PearTune container.`)
    e.code = 'ENOENT'
    throw e
  }
  if (!st.isDirectory()) throw new Error(`${dir} is a file, not a folder.`)

  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    throw new Error(`${dir} cannot be read inside the PearTune container.`)
  }

  const kids = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))

  const dirs = []
  for (const name of kids) {
    const full = path.join(dir, name)
    dirs.push({ name, path: full, music: await hasAudio(full) })
  }

  return {
    path: dir,
    parent: dir === '/' ? null : path.dirname(dir),
    // Audio sitting directly in this directory, which is what makes "Use this
    // folder" meaningful when you are already standing in the album.
    here: entries.filter(e => e.isFile() && isAudio(e.name)).length,
    dirs,
    // Named so a first-time operator, staring at a filesystem they did not expect,
    // has something to click.
    mounts: dir === '/' ? await visibleMounts() : []
  }
}

module.exports = { browse, hasAudio }
