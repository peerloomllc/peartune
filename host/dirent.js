// What IS this directory entry - a folder, a file, or neither?
//
// THE BUG THIS EXISTS FOR (issue #390). `readdir(dir, { withFileTypes: true })`
// describes the LINK, never the thing it points at. So a symlinked album folder
// answers FALSE to both isDirectory() and isFile(), and every walk in the host
// used to drop it on the floor without a word: the music was plainly there, the
// operator pressed Rescan, nothing changed and no log said why.
//
// Windows junctions (`mklink /J`, and the ones Windows itself puts in a user
// profile) arrive here as symlinks too, so the same line dropped those.
//
// What this does NOT cover, and cannot: a Windows .lnk shortcut - the kind
// Explorer makes from right-click -> Create shortcut - is an ORDINARY FILE
// holding a binary record of a path. The operating system does not follow it for
// us the way it follows a symlink, so neither does stat().

const fsp = require('fs/promises')
const path = require('path')

// Returns 'dir', 'file', or null for anything else (a socket, a fifo, a device
// node, a link pointing at nothing).
async function entryKind (dir, e) {
  if (e.isDirectory()) return 'dir'
  if (e.isFile()) return 'file'
  if (!e.isSymbolicLink()) return null

  // stat() follows the link, which is the whole point. A dangling one throws, and
  // a link to a file somebody has since deleted is not a reason to fail a scan.
  // It is just nothing to play.
  const st = await fsp.stat(path.join(dir, e.name)).catch(() => null)
  if (!st) return null
  return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null
}

module.exports = { entryKind }
