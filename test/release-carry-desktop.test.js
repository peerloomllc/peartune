// A release that skips a desktop platform carries the previous installer forward.
//
// v1.0.11 (2026-09-22) was cut for Android only, and the release script uploads only what
// it built in that run, so releases/latest lost every desktop download. The helper is run
// for real here, against a fake GitHub served from file:// URLs, the same way
// release-carry-apk.test.js tests its APK twin.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.sh'), 'utf8')
const helper = SCRIPT.match(/^_carry_forward_desktop\(\) \{[\s\S]*?^\}$/m)[0]

const INSTALLERS = ['PearTune-1.0.10.AppImage', 'peartune-desktop_1.0.10_amd64.deb', 'PearTune-Setup-1.0.10.exe',
  'PearTune-1.0.10.dmg', 'PearTune-1.0.10-arm64.dmg']

function fakeRelease ({ badSum = null, noSum = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-dt-'))
  const files = path.join(dir, 'files')
  fs.mkdirSync(files)
  const assets = []
  for (const name of ['peartune-v1.0.10.apk', ...INSTALLERS]) {
    const body = Buffer.from('not really ' + name)
    fs.writeFileSync(path.join(files, name), body)
    assets.push({ name, browser_download_url: `file://${files}/${name}` })
    if (name === noSum) continue
    const hash = name === badSum ? '0'.repeat(64) : crypto.createHash('sha256').update(body).digest('hex')
    fs.writeFileSync(path.join(files, name + '.sha256'), `${hash}  ${name}\n`)
    assets.push({ name: name + '.sha256', browser_download_url: `file://${files}/${name}.sha256` })
  }
  const api = path.join(dir, 'api', 'repos', 'o', 'r', 'releases')
  fs.mkdirSync(api, { recursive: true })
  fs.writeFileSync(path.join(api, 'latest'), JSON.stringify({ tag_name: 'v1.0.10', assets }))
  return dir
}

function carry (dir, built = []) {
  const dest = path.join(dir, 'dest')
  const args = built.map(b => `"${b}"`).join(' ')
  const r = spawnSync('bash', ['-c', `set -euo pipefail\n${helper}\n_carry_forward_desktop "" o/r "${dest}" ${args}`], {
    env: { ...process.env, GITHUB_API: `file://${dir}/api` }
  })
  assert.equal(r.status, 0, String(r.stderr))
  return String(r.stdout).split('\n').filter(Boolean).map(p => path.basename(p))
}

test('with nothing built, every installer and its checksum comes across, and not the APK', () => {
  const out = carry(fakeRelease())
  assert.deepEqual(out.filter(n => !n.endsWith('.sha256')).sort(), [...INSTALLERS].sort())
  for (const n of INSTALLERS) assert.ok(out.includes(n + '.sha256'), n + ' lost its checksum')
  assert.ok(!out.some(n => n.endsWith('.apk')), 'the APK has its own carry-forward')
})

test('a platform built this run is not carried over its fresh build', () => {
  const out = carry(fakeRelease(), ['/tmp/dist/PearTune-Setup-1.0.11.exe', '/tmp/dist/PearTune-1.0.11-arm64.dmg'])
  assert.ok(!out.includes('PearTune-Setup-1.0.10.exe'))
  assert.ok(!out.includes('PearTune-1.0.10-arm64.dmg'), 'the arm64 dmg was built')
  assert.ok(out.includes('PearTune-1.0.10.dmg'), 'the Intel dmg was not built, so it carries')
  assert.ok(out.includes('PearTune-1.0.10.AppImage'))
})

test('an installer whose checksum is missing or wrong is left behind, and the rest still carry', () => {
  const out = carry(fakeRelease({ badSum: 'PearTune-1.0.10.AppImage', noSum: 'PearTune-Setup-1.0.10.exe' }))
  assert.ok(!out.includes('PearTune-1.0.10.AppImage'))
  assert.ok(!out.includes('PearTune-Setup-1.0.10.exe'))
  assert.ok(out.includes('peartune-desktop_1.0.10_amd64.deb'))
})

test('the helper is wired into the asset list, after this run\'s own desktop builds', () => {
  const i = SCRIPT.indexOf('_carry_forward_desktop "$GH_TOKEN" "$REPO_SLUG"')
  assert.ok(i > 0, 'release.sh never calls _carry_forward_desktop')
  assert.ok(i > SCRIPT.indexOf('for _d in "${DESKTOP_ARTIFACTS[@]}"; do\n  RELEASE_ASSETS+='), 'must run after the built installers are listed')
  assert.ok(i < SCRIPT.indexOf('gh release create "$RELEASE_TAG"'), 'must run before the release is created')
})
