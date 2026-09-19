// A host-only release (--skip-android) carries the previous release's APK forward.
//
// The docs send people to releases/latest for the Android app, and the release script
// only uploads what it built in that run. So a release cut just to ship a host fix
// (issue #430) would have left the latest release with no APK at all. The helper is
// run for real here, against a fake GitHub served from file:// URLs.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

// The helper moved out of scripts/release.sh and into the shared library beside the
// repo (proposals/2026-09-17-shared-release-library.md, PR #437). Look in both, so
// this keeps testing the code that actually runs wherever it ends up living, and say
// which file is missing rather than dying on a null match.
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.sh'), 'utf8')
const SOURCES = [
  path.join(__dirname, '..', 'scripts', 'release.sh'),
  path.join(__dirname, '..', '..', 'peerloom-release', 'release-lib.sh')
]
const helper = (() => {
  for (const file of SOURCES) {
    if (!fs.existsSync(file)) continue
    const m = fs.readFileSync(file, 'utf8').match(/^_carry_forward_apk\(\) \{[\s\S]*?^\}$/m)
    if (m) return m[0]
  }
  throw new Error(
    '_carry_forward_apk found in none of:\n  ' + SOURCES.join('\n  ') +
    '\nThe shared release library is a private repo cloned beside this one; ' +
    'see scripts/release.sh RELEASE_LIB.'
  )
})()

function fakeRelease ({ apk = 'peartune-v1.0.8.apk', goodSum = true, withSum = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-'))
  const files = path.join(dir, 'files')
  fs.mkdirSync(files)
  const assets = [{ name: 'PearTune-1.0.8.dmg', browser_download_url: `file://${files}/PearTune-1.0.8.dmg` }]
  if (apk) {
    const body = Buffer.from('not really an apk')
    fs.writeFileSync(path.join(files, apk), body)
    const hash = goodSum ? crypto.createHash('sha256').update(body).digest('hex') : '0'.repeat(64)
    assets.push({ name: apk, browser_download_url: `file://${files}/${apk}` })
    if (withSum) {
      fs.writeFileSync(path.join(files, apk + '.sha256'), `${hash}  ${apk}\n`)
      assets.push({ name: apk + '.sha256', browser_download_url: `file://${files}/${apk}.sha256` })
    }
  }
  const api = path.join(dir, 'api', 'repos', 'o', 'r', 'releases')
  fs.mkdirSync(api, { recursive: true })
  fs.writeFileSync(path.join(api, 'latest'), JSON.stringify({ tag_name: 'v1.0.8', assets }))
  return dir
}

function carry (dir) {
  const dest = path.join(dir, 'dest')
  const r = spawnSync('bash', ['-c', `set -euo pipefail\n${helper}\n_carry_forward_apk "" o/r "${dest}"`], {
    env: { ...process.env, GITHUB_API: `file://${dir}/api` }
  })
  assert.equal(r.status, 0, String(r.stderr))
  return String(r.stdout).split('\n').filter(Boolean)
}

test('the previous APK and its checksum come across, under their original names', () => {
  const dir = fakeRelease()
  const out = carry(dir)
  assert.deepEqual(out.map(p => path.basename(p)), ['peartune-v1.0.8.apk', 'peartune-v1.0.8.apk.sha256'])
  for (const p of out) assert.ok(fs.existsSync(p))
})

test('a checksum that does not match carries nothing', () => {
  assert.deepEqual(carry(fakeRelease({ goodSum: false })), [])
})

test('no APK, or no checksum beside it, carries nothing and does not fail the run', () => {
  assert.deepEqual(carry(fakeRelease({ apk: null })), [])
  assert.deepEqual(carry(fakeRelease({ withSum: false })), [])
})

test('step 7 carries only when the Android build was skipped', () => {
  assert.match(SCRIPT, /if \$SKIP_ANDROID; then\n  _CARRIED=\$\(_carry_forward_apk "\$GH_TOKEN" "\$REPO_SLUG"/)
})

// The next normal release must not mistake a host-only release for a finished build that
// Zapstore has yet to publish: that shortcut would stop at the artifact/version check.
const ownApk = SCRIPT.match(/^_github_latest_has_own_apk\(\) \{[\s\S]*?^\}$/m)[0]

function hasOwnApk (dir, version) {
  const r = spawnSync('bash', ['-c', `set -euo pipefail\n${ownApk}\nif _github_latest_has_own_apk "" o/r ${version}; then echo yes; else echo no; fi`], {
    env: { ...process.env, GITHUB_API: `file://${dir}/api`, ARTIFACT_PREFIX: 'peartune' }
  })
  assert.equal(r.status, 0, String(r.stderr))
  return String(r.stdout).trim()
}

test('a release with its own APK is a real build; a carried APK is not', () => {
  const dir = fakeRelease()
  assert.equal(hasOwnApk(dir, '1.0.8'), 'yes')
  assert.equal(hasOwnApk(dir, '1.0.9'), 'no')
})

test('a failed GitHub query keeps the old Zapstore shortcut', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-'))
  assert.equal(hasOwnApk(dir, '1.0.9'), 'yes')
})

test('the pre-flight asks before taking the Zapstore shortcut', () => {
  assert.match(SCRIPT, /gt\)[\s\S]{0,600}if ! _github_latest_has_own_apk "\$GH_TOKEN" "\$REPO_SLUG" "\$GH_VERSION"; then[\s\S]{0,200}else\n\s+echo "    Skipping build/)
})
