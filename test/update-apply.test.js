'use strict'

// The verifiable core of "Update now" (slice 1 of
// proposals/2026-07-31-desktop-update-apply.md). Nothing here installs anything -
// this is the part that decides whether we are about to execute the RIGHT FILE.
//
// So the tests are about picking wrong and about refusing, not about the happy path.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const { selectAsset, planApply, downloadAndVerify, parseSha256Sidecar, VerifyError } =
  require('../host/update-apply')

// A release shaped like the one scripts/release.sh actually publishes: every
// desktop artifact, both phone builds, and a .sha256 beside each.
const NAMES = [
  'PearTune-1.1.0.AppImage',
  'peartune-desktop_1.1.0_amd64.deb',
  'PearTune-Setup-1.1.0.exe',
  'PearTune-1.1.0.dmg',
  'PearTune-1.1.0-arm64.dmg',
  'peartune-v1.1.0.apk',
  'peartune-v1.1.0.aab'
]
const ASSETS = NAMES.flatMap(name => ([
  { name, browser_download_url: `https://example.test/${name}` },
  { name: name + '.sha256', browser_download_url: `https://example.test/${name}.sha256` }
]))

const UPDATE = { available: true, latest: '1.1.0', current: '1.0.0' }

test('each platform gets its own artifact, and never a phone build', () => {
  assert.equal(selectAsset(ASSETS, { platform: 'win32' }).name, 'PearTune-Setup-1.1.0.exe')
  assert.equal(selectAsset(ASSETS, { platform: 'linux', appImage: '/home/x/PearTune.AppImage' }).name, 'PearTune-1.1.0.AppImage')
  assert.equal(selectAsset(ASSETS, { platform: 'linux', appImage: '' }).name, 'peartune-desktop_1.1.0_amd64.deb')
  for (const p of ['win32', 'linux', 'darwin']) {
    const picked = selectAsset(ASSETS, { platform: p, arch: 'x64', appImage: '' })
    assert.ok(!/\.(apk|aab)$/.test(picked.name), `${p} must never be handed a phone build`)
  }
})

test('an Intel Mac does not get the arm64 build', () => {
  // The trap: /\.dmg$/ matches "PearTune-1.1.0-arm64.dmg" too, and it happens to
  // come later in the list - so a naive find can hand an Apple Silicon build to an
  // Intel Mac, which fails at launch rather than at download.
  assert.equal(selectAsset(ASSETS, { platform: 'darwin', arch: 'x64' }).name, 'PearTune-1.1.0.dmg')
  assert.equal(selectAsset(ASSETS, { platform: 'darwin', arch: 'arm64' }).name, 'PearTune-1.1.0-arm64.dmg')
})

test('Linux picks by what is RUNNING, not by a guess', () => {
  // The same machine can be running either package. $APPIMAGE is set by the
  // AppImage runtime itself, so it is the honest answer; guessing would offer a
  // .deb to an AppImage user and install a second copy alongside the first.
  assert.match(selectAsset(ASSETS, { platform: 'linux', appImage: '/opt/PearTune.AppImage' }).name, /\.AppImage$/)
  assert.match(selectAsset(ASSETS, { platform: 'linux', appImage: undefined }).name, /\.deb$/)
})

test('NO SIDECAR MEANS NO APPLY', () => {
  // An unverifiable download is not something to execute. This is the whole trust
  // boundary: the artifacts are otherwise unsigned, and macOS cannot even be
  // notarized without breaking LAN pairing.
  const noSidecar = ASSETS.filter(a => !a.name.endsWith('.sha256'))
  assert.throws(() => planApply(UPDATE, noSidecar, { platform: 'win32' }),
    (e) => e instanceof VerifyError && /sha256 sidecar/.test(e.message))
})

test('planning refuses rather than half-answering', () => {
  assert.throws(() => planApply({ available: false }, ASSETS), /no update available/)
  assert.throws(() => planApply(UPDATE, [], { platform: 'win32' }), /no asset for this platform/)
  assert.throws(() => planApply(UPDATE, ASSETS, { platform: 'sunos' }), /no asset for this platform/)
})

test('the plan names the applier the artifact implies', () => {
  assert.equal(planApply(UPDATE, ASSETS, { platform: 'win32' }).applier, 'windows')
  assert.equal(planApply(UPDATE, ASSETS, { platform: 'darwin', arch: 'arm64' }).applier, 'macapp')
  assert.equal(planApply(UPDATE, ASSETS, { platform: 'linux', appImage: '/x.AppImage' }).applier, 'appimage')
  assert.equal(planApply(UPDATE, ASSETS, { platform: 'linux', appImage: '' }).applier, 'deb')
})

test('sidecar parsing takes the digest out of a real shasum line', () => {
  const d = 'a'.repeat(64)
  assert.equal(parseSha256Sidecar(`${d}  PearTune-1.1.0.AppImage\n`), d)
  assert.equal(parseSha256Sidecar('not a digest'), null)
  assert.equal(parseSha256Sidecar(null), null)
})

// --- download + verify, against a stubbed fetch --------------------------------

function stubFetch (bodyByUrl) {
  return async (url) => {
    const v = bodyByUrl[url]
    if (v === undefined) return { ok: false, status: 404 }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(v),
      text: async () => String(v)
    }
  }
}

test('a good download verifies and is kept', async () => {
  const body = 'pretend installer bytes'
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  const plan = { name: 'PearTune-Setup-1.1.0.exe', url: 'u://a', sha256Url: 'u://a.sha256' }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-dl-'))
  const r = await downloadAndVerify(plan, {
    workDir,
    fetchImpl: stubFetch({ 'u://a': body, 'u://a.sha256': `${digest}  ${plan.name}\n` })
  })
  assert.equal(r.digest, digest)
  assert.ok(fs.existsSync(r.file))
  fs.rmSync(workDir, { recursive: true, force: true })
})

test('A TAMPERED DOWNLOAD IS REJECTED AND DELETED', async () => {
  // The one that matters. It must not merely report a problem - it must leave
  // nothing behind for something later to pick up and run.
  const plan = { name: 'PearTune-Setup-1.1.0.exe', url: 'u://a', sha256Url: 'u://a.sha256' }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-dl-'))
  const wrong = crypto.createHash('sha256').update('what we EXPECTED').digest('hex')
  await assert.rejects(
    () => downloadAndVerify(plan, {
      workDir,
      fetchImpl: stubFetch({ 'u://a': 'TAMPERED BYTES', 'u://a.sha256': `${wrong}  ${plan.name}\n` })
    }),
    (e) => e.code === 'VERIFY_FAILED' && /mismatch/.test(e.message))
  assert.ok(!fs.existsSync(path.join(workDir, plan.name)),
    'a rejected artifact must not be left on disk')
  fs.rmSync(workDir, { recursive: true, force: true })
})

test('a missing or unreadable sidecar refuses, it does not skip verification', async () => {
  const plan = { name: 'x.exe', url: 'u://a', sha256Url: 'u://missing' }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-dl-'))
  await assert.rejects(
    () => downloadAndVerify(plan, { workDir, fetchImpl: stubFetch({ 'u://a': 'bytes' }) }),
    (e) => e.code === 'VERIFY_FAILED' && /sidecar http 404/.test(e.message))

  await assert.rejects(
    () => downloadAndVerify(plan, {
      workDir,
      fetchImpl: stubFetch({ 'u://a': 'bytes', 'u://missing': 'this is not a digest' })
    }),
    (e) => e.code === 'VERIFY_FAILED' && /unparseable/.test(e.message))
  fs.rmSync(workDir, { recursive: true, force: true })
})
