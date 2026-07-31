'use strict'

// Every DESKTOP release artifact must ship a .sha256 sidecar, and that sidecar must be
// usable by the person who downloaded it.
//
// Two separate failures, one guarded by each test below:
//
//   1. No sidecar at all. Desktop artifacts shipped bare for every release so far -
//      step 4e generates them for the MOBILE artifacts only. Nothing downstream was
//      missing: the upload step already appends "${asset}.sha256" when the file exists
//      and _asset_content_type already maps .sha256. Only the generation was absent,
//      so there was nothing to verify a desktop download against - which is also the
//      integrity boundary the in-place updater will rest on
//      (proposals/2026-07-31-desktop-update-apply.md).
//
//   2. A sidecar that names the BUILD MACHINE'S PATH. DESKTOP_ARTIFACTS holds absolute
//      paths, and `sha256sum /home/tim/…/PearTune.AppImage` writes that path into the
//      file. It looks correct in the release, and `sha256sum -c` then fails for every
//      downloader on earth, because they have the file under its bare name in their own
//      directory. That is a silent, ship-it-and-never-notice bug, so it is tested by
//      DOING it rather than by reading the script.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const release = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.sh'), 'utf8')

test('release.sh generates a .sha256 for every desktop artifact', () => {
  // Anchored on the loop, not on a loose "sha256sum" match - step 4e already contains
  // one of those for the mobile artifacts, so a bare grep would pass with this removed.
  const idx = release.indexOf('for _f in "${DESKTOP_ARTIFACTS[@]}"')
  assert.ok(idx > 0, 'no loop over DESKTOP_ARTIFACTS')
  const after = release.slice(idx)
  assert.match(after, /sha256sum "\$\(basename "\$_f"\)" > "\$\(basename "\$_f"\)\.sha256"/,
    'the sidecar must be generated from inside the artifact directory, by basename')
})

test('the sidecar a downloader gets actually passes sha256sum -c', () => {
  // The real thing: an artifact at an absolute path, hashed the way release.sh hashes
  // it, then checked from the directory a downloader would have it in.
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartune-build-'))
  const artifact = path.join(buildDir, 'PearTune-9.9.9.AppImage')
  fs.writeFileSync(artifact, 'pretend this is an AppImage')

  // Exactly the command form in release.sh.
  execFileSync('bash', ['-c',
    `cd "$(dirname "$1")" && sha256sum "$(basename "$1")" > "$(basename "$1").sha256"`,
    'bash', artifact])

  const sidecar = artifact + '.sha256'
  const text = fs.readFileSync(sidecar, 'utf8')
  assert.match(text, /^[0-9a-f]{64} {2}PearTune-9\.9\.9\.AppImage\n?$/,
    `sidecar must name the file, not the build path - got: ${text.trim()}`)
  assert.ok(!text.includes(buildDir), 'the build machine path must not leak into the release')

  // Now be the downloader: same two files, a different directory, bare names.
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartune-download-'))
  fs.copyFileSync(artifact, path.join(dlDir, 'PearTune-9.9.9.AppImage'))
  fs.copyFileSync(sidecar, path.join(dlDir, 'PearTune-9.9.9.AppImage.sha256'))
  const ok = execFileSync('sha256sum', ['-c', 'PearTune-9.9.9.AppImage.sha256'], { cwd: dlDir }).toString()
  assert.match(ok, /OK/)

  // And a tampered download must FAIL, or the sidecar is decoration.
  fs.writeFileSync(path.join(dlDir, 'PearTune-9.9.9.AppImage'), 'tampered')
  assert.throws(
    () => execFileSync('sha256sum', ['-c', 'PearTune-9.9.9.AppImage.sha256'], { cwd: dlDir, stdio: 'pipe' }),
    'a modified artifact must not verify')

  fs.rmSync(buildDir, { recursive: true, force: true })
  fs.rmSync(dlDir, { recursive: true, force: true })
})
