#!/usr/bin/env node
'use strict'

// Move a Windows PearTune library from the tray app's per-user location to the
// machine-wide one a LocalSystem service can actually read.
//
//   %APPDATA%\peartune-desktop\data   ->   C:\ProgramData\PearTune\data
//
// WHY THIS EXISTS, and why it is the most dangerous file in the Windows slice:
// host.seed is the library's IDENTITY - the key every paired phone knows it by -
// and store/ is the grant list of who may connect. Nothing regenerates either. A
// service that starts against an empty ProgramData directory comes up perfectly
// healthy AS A DIFFERENT LIBRARY, and every phone that ever paired stops
// recognising it. There is no error message for that; it just silently is not
// your library any more.
//
// So the rules here are deliberately paranoid:
//
//   * THE SOURCE IS NEVER DELETED. Not on success, not ever. It costs a few MB and
//     it is the only way back if something is wrong three days later.
//   * The copy is VERIFIED by digest afterwards, per file - not trusted because
//     the copy call did not throw.
//   * A destination that already holds a seed is left completely alone, so this is
//     safe to run on every upgrade (the installer will).
//   * Any failure exits non-zero WITHOUT having removed anything, so the caller
//     can refuse to start a service pointed at a half-migrated directory.
//
// Pure Node with injectable paths, so it is unit-tested on Linux in CI and then
// run for real on Windows - see test/windows-migrate.test.js.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SEED = 'host.seed'

function defaultSource (env = process.env) {
  return env.APPDATA ? path.join(env.APPDATA, 'peartune-desktop', 'data') : null
}

function defaultDest (env = process.env) {
  return path.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'PearTune', 'data')
}

function sha256 (file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// Every file under dir, as paths relative to it. Sorted so two listings compare.
function walk (dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, base, out)
    else if (e.isFile()) out.push(path.relative(base, full))
  }
  return out.sort()
}

function copyTree (from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const rel of walk(from)) {
    const dst = path.join(to, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(path.join(from, rel), dst)
  }
}

// The whole point of the exercise. A copy that "succeeded" is not the claim we
// need; the claim we need is that the identity and the grants arrived intact.
function verifyTree (from, to) {
  const missing = []
  const corrupt = []
  for (const rel of walk(from)) {
    const dst = path.join(to, rel)
    if (!fs.existsSync(dst)) { missing.push(rel); continue }
    if (sha256(path.join(from, rel)) !== sha256(dst)) corrupt.push(rel)
  }
  return { ok: missing.length === 0 && corrupt.length === 0, missing, corrupt }
}

function migrate ({ from, to, dryRun = false, log = console.log } = {}) {
  if (!from || !fs.existsSync(path.join(from, SEED))) {
    log(`migrate: no library at ${from || '(unknown)'} - nothing to migrate (fresh install).`)
    return { status: 'nothing-to-do' }
  }

  // Already migrated. Safe to run on every upgrade, and it must NOT re-copy over a
  // library the service has been writing to since - that would roll back grants.
  if (fs.existsSync(path.join(to, SEED))) {
    const same = sha256(path.join(from, SEED)) === sha256(path.join(to, SEED))
    log(`migrate: ${to} already holds a library (${same ? 'same identity' : 'A DIFFERENT identity'}) - leaving it untouched.`)
    return { status: 'already-migrated', sameIdentity: same }
  }

  const seedBefore = sha256(path.join(from, SEED))
  const files = walk(from).length
  log(`migrate: ${files} files, identity ${seedBefore.slice(0, 12)}…`)
  log(`  from ${from}`)
  log(`  to   ${to}`)
  if (dryRun) return { status: 'dry-run', files, seed: seedBefore }

  copyTree(from, to)

  const v = verifyTree(from, to)
  if (!v.ok) {
    log(`migrate: VERIFY FAILED - ${v.missing.length} missing, ${v.corrupt.length} corrupt.`)
    log('  The original is untouched. Do NOT start a service against the destination.')
    return { status: 'verify-failed', ...v }
  }
  if (sha256(path.join(to, SEED)) !== seedBefore) {
    log('migrate: the copied host.seed does not match. The original is untouched.')
    return { status: 'verify-failed', missing: [], corrupt: [SEED] }
  }

  log(`migrate: OK - ${files} files verified, identity ${seedBefore.slice(0, 12)}… preserved.`)
  log(`  The original is INTENTIONALLY left at ${from} as a fallback.`)
  return { status: 'migrated', files, seed: seedBefore }
}

module.exports = { migrate, verifyTree, copyTree, walk, defaultSource, defaultDest, SEED }

if (require.main === module) {
  const argv = process.argv.slice(2)
  const arg = (name, dflt) => {
    const i = argv.indexOf(name)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
  }
  const r = migrate({
    from: arg('--from', defaultSource()),
    to: arg('--to', defaultDest()),
    dryRun: argv.includes('--dry-run')
  })
  process.exit(r.status === 'verify-failed' ? 1 : 0)
}
