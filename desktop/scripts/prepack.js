#!/usr/bin/env node
// Copies the host's source (../host, ../protocol, ../client) into desktop/vendor/
// so this Electron subproject is fully self-contained for electron-builder. The
// host requires ../protocol and ../client relatively, so we preserve that layout:
//   vendor/host/  vendor/protocol/  vendor/client/
// Runs from postinstall (dev launch needs vendor/ populated) and each build:*.
//
// We copy SOURCE only - never node_modules (desktop/ has its own), the Dockerfile,
// the deploy samples, host/package*.json, or host/ui/app/ (the React source; the
// built host/ui/dashboard.html is what the host serves at runtime).

const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const vendorDir = path.join(__dirname, '..', 'vendor')

const SKIP_DIRS = new Set(['node_modules', 'deploy', 'app'])
const SKIP_NAMES = new Set([
  'package.json', 'package-lock.json', 'Dockerfile', '.gitignore'
])

function copyDir (from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    if (entry.isFile() && (SKIP_NAMES.has(entry.name) || entry.name.endsWith('.test.js'))) continue
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else if (entry.isFile()) fs.copyFileSync(src, dst)
  }
}

const VENDORED = ['protocol', 'client', 'host']

function main () {
  // Wipe what we are about to re-copy, so removed/renamed source doesn't linger in a
  // build - but ONLY that, not all of vendor/.
  //
  // This used to `rmSync(vendorDir)` wholesale, which was fine while vendor/ held
  // nothing but copies. vendor/ffmpeg is different: it is BUILT by
  // scripts/ffmpeg/build.sh, not copied from anywhere, and on the Mac it arrives by
  // rsync before npm install runs. A blanket wipe deleted it every single time -
  // locally right after building it, and remotely between the rsync and the pack.
  for (const dir of VENDORED) {
    const d = path.join(vendorDir, dir)
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true })
  }

  for (const dir of VENDORED) {
    const from = path.join(repoRoot, dir)
    if (!fs.existsSync(from)) {
      console.error(`[prepack] missing ${dir} at ${from}`)
      process.exit(1)
    }
    copyDir(from, path.join(vendorDir, dir))
  }

  // Sanity: every file the Electron main requires, plus what the host serves at
  // runtime. A miss here is a packaged app that dies on launch with MODULE_NOT_FOUND,
  // which is a far worse place to find out than a failed pack.
  for (const f of ['host/server.js', 'host/ui/server.js', 'host/ui/dashboard.html', 'host/update-check.js']) {
    if (!fs.existsSync(path.join(vendorDir, f))) {
      console.error(`[prepack] expected ${f} in vendor/ but it is missing`)
      process.exit(1)
    }
  }
  console.log('[prepack] vendored host/ protocol/ client/ → desktop/vendor/')
}

main()
