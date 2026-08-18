// desktop/package.json's version MUST equal app.json's expo.version.
//
// Same family of guard as release-signing.test.js: a silent failure that produces
// a build which installs fine and is wrong in a way nobody notices for a release
// or two.
//
// WHY IT MATTERS. electron-builder bakes desktop/package.json's version into every
// artifact filename (PearTune-<v>.AppImage, PearTune-Setup-<v>.exe, PearTune-<v>.dmg,
// peartune-desktop_<v>_amd64.deb). The updater compares a desktop install's own
// version against the repo's latest release TAG, which release.sh derives from
// app.json - host/update-check.js states the premise outright: "ONE VERSION LINE...
// everything PearTune ships now moves together" (Tim, 2026-07-31). Let the two
// numbers drift and the desktop artifacts on a release are stamped with the old one.
//
// THIS ALREADY SHIPPED ONCE. v1.0.1 (2026-08-17) rebuilt the desktop artifacts for
// real - the AppImage grew from 183,713,718 to 183,750,579 bytes, so they genuinely
// carried the speakers / .wma / off-LAN work - but named them PearTune-1.0.0.*,
// because desktop/package.json had never moved off 1.0.0. host/update-apply.js
// selects assets by SHAPE rather than version, so all five platform/arch
// combinations planned an apply that announced "1.0.1" and handed back a file
// stamped 1.0.0. The sha256 check passed every time, because the digest of the
// wrong artifact is still that artifact's digest. A user would be told the update
// succeeded, still read as 1.0.0, and be re-offered the same update forever.
//
// planApply now refuses a version mismatch outright, and release.sh refuses to build
// desktop artifacts whose version does not match the tag. This test is the earliest
// of the three gates: it fails at `npm run verify` rather than at release time.

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const root = path.join(__dirname, '..')

test('desktop/package.json version matches app.json expo.version', () => {
  const appVersion = require(path.join(root, 'app.json')).expo.version
  const desktopVersion = require(path.join(root, 'desktop', 'package.json')).version

  assert.equal(
    desktopVersion,
    appVersion,
    `desktop/package.json is ${desktopVersion} but app.json is ${appVersion}. ` +
    'electron-builder names every desktop artifact after the desktop version, and the ' +
    'updater compares against the release tag (taken from app.json), so a mismatch ships ' +
    'desktop builds labelled with the wrong version and the in-app update refuses them. ' +
    `Fix: npm --prefix desktop version ${appVersion} --no-git-tag-version`
  )
})

test('both versions are plain X.Y.Z, which is what the artifact names and the tag assume', () => {
  // release.sh validates the tag as ^v[0-9]+\.[0-9]+\.[0-9]+$ and the updater parses the
  // same shape. A suffix here (1.0.1-beta) would produce artifact names the asset picker
  // still matches on shape but whose version no longer compares the way anyone expects.
  for (const [label, version] of [
    ['app.json expo.version', require(path.join(root, 'app.json')).expo.version],
    ['desktop/package.json version', require(path.join(root, 'desktop', 'package.json')).version]
  ]) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${label} must be plain X.Y.Z, got ${version}`)
  }
})
