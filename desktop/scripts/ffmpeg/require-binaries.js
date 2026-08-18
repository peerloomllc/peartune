#!/usr/bin/env node
// Refuse to package a desktop installer that has no ffmpeg in it.
//
// The binaries are gitignored (see ../../.gitignore), so a fresh clone has none, and
// electron-builder does NOT treat a missing extraResources source as fatal. Without
// this guard the build succeeds, the installer ships, and the host silently falls back
// to a bare `ffmpeg` on PATH that a normal Mac or Windows machine does not have -
// which is exactly the bug the bundling exists to fix, shipped back invisibly.
//
// The list of what is required is READ FROM package.json rather than written here, so
// adding a platform to `build.<platform>.extraResources` extends this check for free
// and the two can never disagree.
//
// Usage: node scripts/ffmpeg/require-binaries.js <mac|win|linux>

const fs = require('fs')
const path = require('path')

const platform = process.argv[2]
if (!['mac', 'win', 'linux'].includes(platform)) {
  console.error('usage: require-binaries.js <mac|win|linux>')
  process.exit(2)
}

const desktopDir = path.resolve(__dirname, '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'))
const wanted = (pkg.build?.[platform]?.extraResources || [])
  .filter((r) => String(r.to).startsWith('ffmpeg/'))

if (wanted.length === 0) {
  console.error(
    `\nERROR: desktop/package.json stages no ffmpeg for "${platform}".\n` +
    '  Every desktop platform needs one, or that platform cannot transcode and any\n' +
    '  format the phone cannot decode plays as silence. See scripts/ffmpeg/README.md.\n'
  )
  process.exit(1)
}

const missing = []
for (const r of wanted) {
  const dir = path.join(desktopDir, r.from)
  const bin = ['ffmpeg', 'ffmpeg.exe'].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p))
  if (!bin) { missing.push(`${r.from} (no ffmpeg binary in it)`); continue }
  // A truncated or half-copied binary is worse than an absent one: it passes an
  // existence check and fails at the moment a user plays a track.
  const size = fs.statSync(bin).size
  if (size < 1_000_000) missing.push(`${r.from} (only ${size} bytes - truncated?)`)
}

if (missing.length) {
  console.error(
    `\nERROR: the ${platform} build needs bundled ffmpeg binaries that are not here:\n` +
    missing.map((m) => `    ${m}`).join('\n') +
    '\n\n  They are gitignored on purpose, so a fresh clone never has them.\n' +
    '  Build them once with:\n\n' +
    '      desktop/scripts/ffmpeg/build.sh\n' +
    '      desktop/scripts/ffmpeg/check.sh      # and prove they work\n\n' +
    '  Refusing to package rather than shipping an installer that cannot transcode.\n'
  )
  process.exit(1)
}

console.log(`ffmpeg: ${wanted.length} bundled binar${wanted.length === 1 ? 'y' : 'ies'} present for ${platform}`)
