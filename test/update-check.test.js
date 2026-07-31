// The host's "a new PearTune is out" check.
//
// The properties that matter are the NEGATIVE ones. A banner that appears when it should
// not is worse than no banner - it is the one that stops being believed - and a container
// install that offers a download is telling an Umbrel user to do the wrong thing.

const test = require('node:test')
const assert = require('node:assert/strict')
const { UpdateChecker, evaluateRelease, isNewer, compareVersions, updatesDisabled, hostVersion, createUpdateChecker } = require('../host/update-check')

test('version compare handles the tag shapes releases actually use', () => {
  assert.equal(isNewer('v1.0.1', '1.0.0'), true, 'a v prefix is the normal tag form')
  assert.equal(isNewer('1.0.0', '1.0.0'), false, 'the same version is not an update')
  assert.equal(isNewer('0.9.9', '1.0.0'), false, 'older is not newer')
  assert.equal(isNewer('1.0.1-rc2', '1.0.0'), true, 'a pre-release suffix compares on its numeric core')
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1, 'minor versions compare NUMERICALLY, not as strings')
})

test('an unreadable version never claims an update', () => {
  // Errs toward silence in both directions: this is the check that stops a garbled tag
  // (or a host built without a version) from producing a permanent false banner.
  assert.equal(isNewer('not-a-version', '1.0.0'), false)
  assert.equal(isNewer('1.0.1', 'not-a-version'), false)
  assert.equal(isNewer(undefined, '1.0.0'), false)
})

test('drafts and pre-releases are not offered', () => {
  const r = evaluateRelease({ tag_name: 'v2.0.0', prerelease: true }, '1.0.0')
  assert.equal(r.available, false)
  assert.equal(r.reason, 'prerelease')
  assert.equal(evaluateRelease({ tag_name: 'v2.0.0', draft: true }, '1.0.0').available, false)
})

test('a real newer release reports the version and where to get it', () => {
  const r = evaluateRelease({ tag_name: 'v1.1.0', html_url: 'https://github.com/peerloomllc/peartune/releases/tag/v1.1.0', published_at: '2026-08-01T00:00:00Z' }, '1.0.0')
  assert.equal(r.available, true)
  assert.equal(r.latest, '1.1.0', 'the v is stripped for display')
  assert.match(r.htmlUrl, /releases\/tag\/v1\.1\.0$/)
})

test('IN A CONTAINER THE CHECK IS OFF - Umbrel and the image own updates there', () => {
  // The whole point of the /.dockerenv branch. An Umbrel user is shown "update available"
  // by umbrelOS off the store listing's version; a second banner in the dashboard telling
  // them to download an installer would be telling them to do the wrong thing.
  const fakeFs = { existsSync: (p) => p === '/.dockerenv' }
  assert.deepEqual(updatesDisabled({ env: {}, fs: fakeFs }), { disabled: true, reason: 'container' })
  assert.deepEqual(updatesDisabled({ env: { PEARTUNE_NO_UPDATE_CHECK: '1' }, fs: { existsSync: () => false } }), { disabled: true, reason: 'PEARTUNE_NO_UPDATE_CHECK' })
  assert.deepEqual(updatesDisabled({ env: {}, fs: { existsSync: () => false } }), { disabled: false, reason: null })
})

test('GitHub being down does not throw, and does not retract what we knew', async () => {
  // Fail-open is the whole contract: nothing here may stop a host serving music.
  let call = 0
  const c = new UpdateChecker({
    currentVersion: '1.0.0',
    url: 'https://example.invalid/latest',
    fetchImpl: async () => {
      call++
      if (call === 1) return { ok: true, json: async () => ({ tag_name: 'v1.2.0', html_url: 'u' }) }
      throw new Error('network down')
    }
  })
  await c.check()
  assert.equal(c.get().available, true)

  await c.check() // now it fails
  const s = c.get()
  assert.equal(s.error, 'network down')
  assert.equal(s.available, true, 'a transient failure must not retract a banner that was right')
})

test('the host finds its own version in every layout it ships in', () => {
  // Three layouts disagree about what `..` is: a source checkout (repo root), the
  // docker image (host/package.json, copied to /app) and the desktop app (NEITHER,
  // because prepack.js vendors source without package.json). The last one is the trap:
  // a bare require would throw at startup and take the tray app down with it.
  assert.equal(hostVersion({ env: { PEARTUNE_VERSION: '2.3.4' } }), '2.3.4', 'an explicit version wins')
  assert.equal(hostVersion({ env: {}, load: (p) => p === '../package.json' ? { version: '1.0.0' } : (() => { throw new Error('nope') })() }), '1.0.0')
  assert.equal(hostVersion({ env: {}, load: (p) => p === './package.json' ? { version: '1.0.0' } : (() => { throw new Error('nope') })() }), '1.0.0', 'the docker/host-local copy')
  assert.equal(hostVersion({ env: {}, load: () => { throw new Error('no such file') } }), null, 'the desktop layout: nothing to read, and it must not throw')
  // The fourth layout, found by running the systemd service for real: the host runs from
  // inside resources/app.asar/vendor/host/, where the packaged app's manifest is two up.
  // The tray app never hit this because it passes app.getVersion() in; a serviced host has
  // no Electron `app` to ask, and without this candidate it reports "unknown version" and
  // therefore never checks for updates at all.
  assert.equal(hostVersion({ env: {}, load: (p) => p === '../../package.json' ? { version: '1.0.0' } : (() => { throw new Error('nope') })() }), '1.0.0', 'the packaged desktop-service layout')
})

test('every refusal to check returns null and a reason, and starts nothing', () => {
  // None of these may reach the network, so a checker leaking out of any of them is
  // itself the failure. All three refusals live in this one function so the daemon and
  // the desktop tray cannot drift into different answers.
  const cases = [
    [{ env: { PEARTUNE_NO_UPDATE_CHECK: '1' } }, 'PEARTUNE_NO_UPDATE_CHECK'],
    [{ env: {}, versionOf: () => null }, 'unknown version']
  ]
  for (const [opts, reason] of cases) {
    const r = createUpdateChecker(opts)
    assert.equal(r.checker, null, reason)
    assert.equal(r.reason, reason)
  }
})

test('a rate-limited or 404 response is an error, not an update', async () => {
  const c = new UpdateChecker({ currentVersion: '1.0.0', url: 'x', fetchImpl: async () => ({ ok: false, status: 403 }) })
  await c.check()
  assert.match(c.get().error, /403/)
  assert.equal(c.get().available, false)
})
