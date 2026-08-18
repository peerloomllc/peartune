'use strict'

// Where is ffmpeg?
//
// Three deployments, three answers, and they must all work from the same host code:
//
//   the container image   /usr/local/bin/ffmpeg, a static build baked in by
//                         host/Dockerfile since image 0.2.45. On PATH.
//   a desktop install     a binary shipped INSIDE the app, because a user who
//                         double-clicked a .dmg has no reason to have ffmpeg and no
//                         way to be told to install one. Not on PATH.
//   a source checkout     whatever the developer has, if anything.
//
// Until 2026-08-18 transcode.js read `process.env.PEARTUNE_FFMPEG || 'ffmpeg'`, which
// covers the first and third and silently loses the second: every desktop install
// transcoded nothing, so an unplayable format fell back to raw bytes the phone cannot
// decode - "shows in the app, player says paused", the 2026-08-14 bug, on every Mac and
// Windows library there is.
//
// RESOLUTION ORDER, and each rung earns its place:
//
//   1. PEARTUNE_FFMPEG, verbatim and unchecked. An operator's explicit choice outranks
//      anything we guess, including a bundled binary. Deliberately NOT validated here -
//      see the note on hasFfmpeg() in transcode.js, which probes whatever it gets.
//   2. A bundled binary, relative to this file. Two layouts, both real:
//        ../ffmpeg/<platform>-<arch>/         desktop/vendor/ffmpeg, the dev tree and
//                                             the rsync/vendor layout
//        ../../../ffmpeg/<platform>-<arch>/   resources/ffmpeg in a packaged app, where
//                                             this file is at resources/app.asar/vendor/host/
//      The packaged one deliberately walks OUT of app.asar: a binary inside an asar
//      archive cannot be spawned, so electron-builder stages it beside the archive
//      instead (extraResources). Existence is checked, so a layout that does not apply
//      simply falls through.
//   3. 'ffmpeg' on PATH. The image, and any machine that has its own.
//
// Kept out of transcode.js so the layout arithmetic is testable without spawning
// anything.

const path = require('path')
const fs = require('fs')

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

// Exported for the tests: the arch/platform pair names the vendored directory, and it
// must match what desktop/scripts/build-ffmpeg.sh writes and what package.json stages.
function bundleDir () {
  return `${process.platform}-${process.arch}`
}

// A path INSIDE an asar archive is not a real file: Electron's fs shim makes
// existsSync say yes, but nothing can spawn it - the bytes live inside the archive and
// there is no executable on disk to exec.
//
// This is not hypothetical. The first cut of this shipped exactly that: package.json's
// `files` glob included `vendor/**/*`, so electron-builder packed vendor/ffmpeg INTO
// app.asar as well as staging a real copy beside it, BOTH candidates below reported
// EXISTS, the in-asar one came first and won, and hasFfmpeg() then failed to spawn it
// and silently fell back to raw bytes. The bug the whole change exists to fix, shipped
// inside the fix, and every unit test passed because they mock existsSync.
//
// The glob now excludes it, and this is the belt to that braces: a candidate under an
// .asar is never a spawnable binary, whatever the filesystem claims.
function spawnable (p, exists) {
  return !p.split(path.sep).some((seg) => seg.endsWith('.asar')) && exists(p)
}

function candidates (dir = __dirname) {
  return [
    path.join(dir, '..', 'ffmpeg', bundleDir(), EXE),
    path.join(dir, '..', '..', '..', 'ffmpeg', bundleDir(), EXE)
  ]
}

// `env` and `dir` are injectable so the resolution order can be tested on a fixture
// tree rather than only on the machine the tests happen to run on.
function resolveFfmpeg ({ env = process.env, dir = __dirname, exists = fs.existsSync } = {}) {
  if (env.PEARTUNE_FFMPEG) return env.PEARTUNE_FFMPEG
  for (const c of candidates(dir)) {
    if (spawnable(c, exists)) return c
  }
  return 'ffmpeg'
}

module.exports = { resolveFfmpeg, candidates, spawnable, bundleDir, EXE }
