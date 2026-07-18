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

function main () {
  // Wipe vendor/ first so removed/renamed source doesn't linger in a build.
  if (fs.existsSync(vendorDir)) fs.rmSync(vendorDir, { recursive: true })

  for (const dir of ['protocol', 'client', 'host']) {
    const from = path.join(repoRoot, dir)
    if (!fs.existsSync(from)) {
      console.error(`[prepack] missing ${dir} at ${from}`)
      process.exit(1)
    }
    copyDir(from, path.join(vendorDir, dir))
  }

  // Sanity: the two files the Electron main + the host serve at runtime.
  for (const f of ['host/server.js', 'host/ui/server.js', 'host/ui/dashboard.html']) {
    if (!fs.existsSync(path.join(vendorDir, f))) {
      console.error(`[prepack] expected ${f} in vendor/ but it is missing`)
      process.exit(1)
    }
  }
  console.log('[prepack] vendored host/ protocol/ client/ → desktop/vendor/')
}

main()
