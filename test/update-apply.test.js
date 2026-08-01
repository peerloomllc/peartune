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

// --- slice 2: the two appliers that need no root -------------------------------

const { detectSupervisor, applyUpdate, NeedsManualError } = require('../host/update-apply')

// Records every command instead of running it, so the SEQUENCE can be asserted.
function recorder (answers = {}) {
  const calls = []
  const exec = async (argv) => {
    calls.push(argv.join(' '))
    for (const [match, out] of Object.entries(answers)) {
      if (argv.join(' ').includes(match)) return out
    }
    return ''
  }
  return { calls, exec }
}

test('a supervisor is DETECTED, never assumed - the same AppImage runs both ways', async () => {
  const active = recorder({ 'systemctl --user is-active': 'active\n' })
  assert.equal(await detectSupervisor({ platform: 'linux', exec: active.exec }), 'systemd')

  const inactive = recorder({ 'systemctl --user is-active': 'inactive\n' })
  assert.equal(await detectSupervisor({ platform: 'linux', exec: inactive.exec }), null)

  const win = recorder({ 'sc.exe query': 'STATE : 4  RUNNING' })
  assert.equal(await detectSupervisor({ platform: 'win32', exec: win.exec }), 'windows-service')

  // A throwing exec means "no service", never a crash. An update check must not be
  // able to take the host down.
  const boom = { exec: async () => { throw new Error('no systemctl') } }
  assert.equal(await detectSupervisor({ platform: 'linux', exec: boom.exec }), null)
})

test('the AppImage swap keeps the executable bit, then hands off to systemd', async () => {
  const r = recorder()
  const out = await applyUpdate({ applier: 'appimage', version: '1.1.0' },
    { file: '/tmp/new.AppImage', target: '/home/tim/PearTune.AppImage', supervisor: 'systemd', exec: r.exec })

  assert.match(r.calls[0], /^install -m 0755 \/tmp\/new\.AppImage \/home\/tim\/PearTune\.AppImage$/,
    'a plain copy would drop the executable bit and leave an AppImage that will not launch')
  // --no-block or the restart tears down our own cgroup and kills the systemctl
  // child before it returns 0 - reporting an error on a SUCCESSFUL update.
  assert.match(r.calls[1], /systemctl --user restart --no-block peartune-host\.service/)
  assert.equal(out.restarted, true)
  assert.equal(out.via, 'systemd')
})

test('unsupervised, the swap happens but the RELAUNCH is left to the app', async () => {
  // The one case where a process must re-execute a file it just overwrote. It is
  // the app's problem, not this module's, and it must be reported rather than
  // silently skipped - otherwise the user is told it updated and it did not.
  const r = recorder()
  const out = await applyUpdate({ applier: 'appimage', version: '1.1.0' },
    { file: '/tmp/new.AppImage', target: '/home/tim/PearTune.AppImage', supervisor: null, exec: r.exec })
  assert.equal(r.calls.length, 1, 'no restart command when nothing is supervising')
  assert.equal(out.needsRelaunch, true)
  assert.equal(out.restarted, false)
})

test('no AppImage path means REFUSE, not swap something else', async () => {
  await assert.rejects(
    () => applyUpdate({ applier: 'appimage', version: '1.1.0' }, { file: '/tmp/new', target: '', exec: async () => '' }),
    (e) => e.code === 'NEEDS_MANUAL')
})

test('the Windows installer is launched DETACHED, or it kills itself mid-swap', async () => {
  // NSSM reaps its service's whole process tree on stop, and the installer stops
  // the service. A child would be killed part-way through replacing files.
  // Win32_Process.Create re-parents it under WmiPrvSE.
  const r = recorder()
  const out = await applyUpdate({ applier: 'windows', version: '1.1.0' },
    { file: 'C:\\tmp\\PearTune-Setup-1.1.0.exe', exec: r.exec })
  assert.match(r.calls[0], /Win32_Process/, 'a plain spawn would be reaped when the installer stops the service')
  assert.match(r.calls[0], /\/S/, 'silent, or an unattended update waits on a wizard nobody can see')
  assert.equal(out.restarted, true)
})

test('the unwired platforms THROW rather than reporting a success they did not have', async () => {
  for (const applier of ['deb', 'macapp']) {
    await assert.rejects(
      () => applyUpdate({ applier, version: '1.1.0' }, { file: '/tmp/x', exec: async () => '' }),
      (e) => e.code === 'NEEDS_MANUAL', `${applier} must refuse, so the caller can offer the download`)
  }
})

// --- the driver behind POST /api/update/apply -----------------------------------

const { UpdateApplier } = require('../host/update-apply')

const RELEASE = { available: true, latest: '1.1.0', current: '1.0.0', htmlUrl: 'https://gh/releases/v1.1.0', assets: ASSETS }

function applierFor (over = {}) {
  const body = 'installer bytes'
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  const urls = {}
  for (const a of ASSETS) urls[a.browser_download_url] = a.name.endsWith('.sha256') ? `${digest}  x\n` : body
  const r = recorder({ 'systemctl --user is-active': 'active\n' })
  return {
    calls: r.calls,
    applier: new UpdateApplier({
      getUpdate: () => RELEASE,
      platform: 'linux',
      target: '/home/tim/PearTune.AppImage',
      exec: r.exec,
      fetchImpl: stubFetch(urls),
      ...over
    })
  }
}

test('a full apply verifies, swaps, and reports restarting', async () => {
  const { applier, calls } = applierFor()
  assert.equal(applier.getState().status, 'idle')
  const s = await applier.apply()
  assert.equal(s.status, 'restarting')
  assert.equal(s.version, '1.1.0')
  assert.ok(calls.some(c => c.startsWith('install -m 0755')))
})

test('NOTHING HAPPENING MUST NEVER LOOK LIKE IT WORKED', async () => {
  // Every failure lands on a state that offers the release page - the same thing
  // the banner did before this feature existed. Falling back to "download it
  // yourself" is always available and never wrong.
  const { applier } = applierFor({ platform: 'darwin', arch: 'arm64' })
  const s = await applier.apply()
  assert.equal(s.status, 'needs-manual', 'macOS is not wired yet and must say so')
  assert.equal(s.htmlUrl, RELEASE.htmlUrl, 'the operator is always offered the download')
})

test('a tampered download reports ERROR, distinctly from not-wired', async () => {
  // These are different problems and the dashboard says so: one means the download
  // is wrong, the other means this platform cannot self-apply yet.
  const urls = {}
  for (const a of ASSETS) urls[a.browser_download_url] = a.name.endsWith('.sha256') ? `${'b'.repeat(64)}  x\n` : 'TAMPERED'
  const r = recorder({ 'systemctl --user is-active': 'active\n' })
  const applier = new UpdateApplier({
    getUpdate: () => RELEASE, platform: 'linux', target: '/home/tim/PearTune.AppImage',
    exec: r.exec, fetchImpl: stubFetch(urls)
  })
  const s = await applier.apply()
  assert.equal(s.status, 'error')
  assert.match(s.error, /mismatch/)
  assert.ok(!r.calls.some(c => c.startsWith('install ')), 'nothing may be installed after a failed verify')
})

test('with no update there is nothing to apply', async () => {
  const applier = new UpdateApplier({ getUpdate: () => ({ available: false }) })
  assert.equal((await applier.apply()).status, 'no-update')
})

test('a second click does not start a second 130MB download', async () => {
  const { applier } = applierFor()
  applier._state = { status: 'running', version: '1.1.0' }
  assert.equal((await applier.apply()).status, 'running')
})
