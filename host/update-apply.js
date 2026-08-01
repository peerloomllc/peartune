// "Update now" - the verifiable core (slice 1 of
// proposals/2026-07-31-desktop-update-apply.md).
//
// This file downloads and PROVES an update artifact. It does not install anything;
// the per-platform appliers land in later slices. Keeping the proving separate is
// deliberate - it is the part that decides whether we are about to execute the
// right file, and it is the part that can be tested without a machine per platform.
//
// THE TRUST BOUNDARY is HTTPS to the official repo's releases plus the published
// `.sha256` sidecar, which scripts/release.sh emits for every desktop artifact.
// PearTune's artifacts are otherwise unsigned - and CANNOT be notarized on macOS,
// because hardened runtime silently blocks HyperDHT's raw UDP and would break
// same-network pairing (desktop/scripts/build-mac.sh). Signing the Windows and
// Linux artifacts is future hardening, and is REQUIRED before any apply that is
// not gated on an operator clicking a button.
//
// A LESSON FROM THE WINDOWS SERVICE SLICE, which is why verification here is by
// digest of the file actually on disk rather than by "the download did not throw":
// three separate times that week a green-looking check proved the easy claim
// instead of the one that mattered. A download that returned 200 is not the claim.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

class VerifyError extends Error {
  constructor (msg) { super(msg); this.code = 'VERIFY_FAILED' }
}

// Pull the 64-hex digest out of a `<hex>  <filename>` shasum sidecar.
function parseSha256Sidecar (text) {
  if (typeof text !== 'string') return null
  const m = text.trim().match(/\b([0-9a-f]{64})\b/i)
  return m ? m[1].toLowerCase() : null
}

function sha256File (file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const s = fs.createReadStream(file)
    s.on('error', reject)
    s.on('data', (d) => hash.update(d))
    s.on('end', () => resolve(hash.digest('hex')))
  })
}

// Which asset does THIS machine need? The release carries every platform's, plus the
// phone builds, so picking wrong means downloading a verified artifact that is
// useless here - or worse, handing a .apk to an installer.
//
// The names come from scripts/release.sh step 5b:
//   PearTune-<v>.AppImage          peartune-desktop_<v>_amd64.deb
//   PearTune-Setup-<v>.exe         PearTune-<v>.dmg   PearTune-<v>-arm64.dmg
//
// Linux is the one that needs a question asked rather than a rule applied: the SAME
// machine can be running either package. $APPIMAGE is set by the AppImage's own
// runtime, so its presence is the honest answer to "which one am I?" - guessing
// would offer a .deb to someone running an AppImage, which installs a second copy.
function selectAsset (assets, { platform = process.platform, arch = process.arch, appImage = process.env.APPIMAGE } = {}) {
  const list = (assets || []).filter(a => a && typeof a.name === 'string')
  const by = (re) => list.find(a => re.test(a.name))

  let asset = null
  if (platform === 'win32') asset = by(/^PearTune-Setup-.*\.exe$/i)
  else if (platform === 'darwin') {
    // The arm64 build is named with the suffix; the x64 one is the bare .dmg. A
    // plain /\.dmg$/ would match the arm64 file first on an Intel Mac.
    asset = arch === 'arm64' ? by(/-arm64\.dmg$/i) : list.find(a => /\.dmg$/i.test(a.name) && !/-arm64\.dmg$/i.test(a.name))
  } else if (platform === 'linux') {
    asset = appImage ? by(/\.AppImage$/i) : by(/\.deb$/i)
  }
  if (!asset) return null

  // The sidecar is a SEPARATE asset named "<artifact>.sha256". No sidecar, no
  // apply - there would be nothing to verify against, and an unverified download
  // is not something to execute.
  const sha = list.find(a => a.name === asset.name + '.sha256')
  return {
    name: asset.name,
    url: asset.browser_download_url || null,
    sha256Url: sha ? (sha.browser_download_url || null) : null
  }
}

// Turn an update (from update-check.js) plus the release's assets into "what will
// happen". Pure, and it throws rather than returning something half-usable.
function planApply (update, assets, opts = {}) {
  if (!update || !update.available) throw new Error('no update available to apply')
  const picked = selectAsset(assets, opts)
  if (!picked) throw new Error(`no asset for this platform (${opts.platform || process.platform}/${opts.arch || process.arch})`)
  if (!picked.url) throw new Error(`asset ${picked.name} has no download url`)
  if (!picked.sha256Url) throw new VerifyError(`asset ${picked.name} has no .sha256 sidecar - refusing to apply an unverifiable download`)

  const platform = opts.platform || process.platform
  const applier = platform === 'win32' ? 'windows'
    : platform === 'darwin' ? 'macapp'
      : /\.AppImage$/i.test(picked.name) ? 'appimage' : 'deb'

  return { applier, version: update.latest, ...picked }
}

async function download (url, dest, { fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  const res = await doFetch(url, { redirect: 'follow', headers: { 'user-agent': 'peartune-host' } })
  if (!res.ok) throw new Error(`download http ${res.status}`)
  await fs.promises.writeFile(dest, Buffer.from(await res.arrayBuffer()))
  return dest
}

// Download the artifact and its sidecar, and prove the bytes on disk match. On any
// mismatch the file is REMOVED - leaving a rejected artifact lying around invites
// something later to pick it up.
async function downloadAndVerify (plan, { workDir, fetchImpl } = {}) {
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'peartune-update-'))
  const file = path.join(dir, plan.name)

  await download(plan.url, file, { fetchImpl })

  const doFetch = fetchImpl || globalThis.fetch
  const res = await doFetch(plan.sha256Url, { redirect: 'follow', headers: { 'user-agent': 'peartune-host' } })
  if (!res.ok) throw new VerifyError(`sha256 sidecar http ${res.status}`)
  const expected = parseSha256Sidecar(await res.text())
  if (!expected) throw new VerifyError('unparseable sha256 sidecar')

  const actual = await sha256File(file)
  if (actual !== expected) {
    try { await fs.promises.unlink(file) } catch {}
    throw new VerifyError(`sha256 mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`)
  }
  return { file, digest: actual, dir }
}

// ---------------------------------------------------------------------------
// Applying it (slice 2: the two paths that need no root)
// ---------------------------------------------------------------------------

const UNIT = 'peartune-host.service'
const WIN_SERVICE = 'PearTuneHost'

class NeedsManualError extends Error {
  constructor (why) { super(why); this.code = 'NEEDS_MANUAL' }
}

// IS SOMETHING SUPERVISING US? This changes the ending, not the middle.
//
// Supervised, the process that swapped the payload simply exits and the service
// manager starts a FRESH one from the new file. Unsupervised, the running process
// has to relaunch itself from a file it just overwrote - which is the case the
// proposal listed as an open question, and the case we now mostly avoid.
//
// It must be DETECTED rather than assumed, because the same AppImage runs both
// ways: as a supervised systemd user service, or as a plain tray app someone
// double-clicked.
async function detectSupervisor ({ platform = process.platform, exec } = {}) {
  if (!exec) return null
  try {
    if (platform === 'linux') {
      const out = await exec(['systemctl', '--user', 'is-active', UNIT])
      return String(out || '').trim() === 'active' ? 'systemd' : null
    }
    if (platform === 'win32') {
      const out = await exec(['sc.exe', 'query', WIN_SERVICE])
      return /RUNNING/i.test(String(out || '')) ? 'windows-service' : null
    }
  } catch {
    // A non-zero exit just means "no service". Never fatal: an update check that
    // cannot tell must not take the host down with it.
  }
  return null
}

const APPLIERS = {
  // Swap the AppImage payload in place, then let the supervisor restart us.
  //
  // `install -m 0755` rather than a copy: it replaces the file atomically enough
  // and keeps the executable bit, which a plain write would drop and leave the
  // user with an AppImage that will not launch.
  appimage: async ({ file, target, supervisor, exec }) => {
    if (!target) throw new NeedsManualError('no AppImage path to replace ($APPIMAGE is unset)')
    await exec(['install', '-m', '0755', file, target])
    if (supervisor === 'systemd') {
      // --no-block IS NOT OPTIONAL. A plain restart tears down this service's
      // cgroup, which kills the `systemctl` child - and us - before it returns 0.
      // That surfaces as an error on a SUCCESSFUL update. The seeder hit exactly
      // this and its comment is why we did not have to.
      await exec(['systemctl', '--user', 'restart', '--no-block', UNIT])
      return { restarted: true, via: 'systemd' }
    }
    // Unsupervised: the caller relaunches. It is the one case where a process
    // re-executes a file it just overwrote, so it is handled by the app, not here.
    return { restarted: false, needsRelaunch: true }
  },

  // Run the verified NSIS installer silently. Its own upgrade path stops the
  // service, replaces the payload, re-registers and starts it again - which is
  // what releases the lock that a plain file copy cannot.
  //
  // IT MUST NOT BE A CHILD OF THE SERVICE. NSSM reaps its service's whole process
  // tree on stop, and the installer STOPS THE SERVICE - so a child would be killed
  // half-way through replacing files. Win32_Process.Create re-parents it under
  // WmiPrvSE, which is the seeder's trick and the reason it works there.
  windows: async ({ file, exec }) => {
    const cmd = `"${file}" /S`
    await exec(['powershell', '-NoProfile', '-NonInteractive', '-Command',
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmd}'} | Out-Null`])
    return { restarted: true, via: 'installer' }
  },

  // Later slices. They throw rather than silently doing nothing, so the caller can
  // fall back to the verified download instead of reporting a success it did not have.
  deb: async () => { throw new NeedsManualError('the .deb update needs a privileged helper (slice 4)') },
  macapp: async () => { throw new NeedsManualError('the macOS update is not wired yet (slice 3)') }
}

async function applyUpdate (plan, { file, digest, supervisor, target = process.env.APPIMAGE, exec, log = () => {} } = {}) {
  const applier = APPLIERS[plan.applier]
  if (!applier) throw new NeedsManualError(`no applier for ${plan.applier}`)
  log('update:applying', { version: plan.version, via: plan.applier })
  const r = await applier({ file, digest, target, supervisor, exec })
  return { ...r, applier: plan.applier, version: plan.version }
}

// Run one command, resolving its stdout. Rejects on a non-zero exit, which is what
// detectSupervisor reads as "no service" and what an applier reads as a failure.
// Kept here so the daemon and the tray app cannot drift into different behaviour.
function defaultExec (argv) {
  const { execFile } = require('child_process')
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

// The stateful driver behind POST /api/update/apply. One in-flight apply at a
// time, and every outcome is a state the dashboard can render - including the
// ones where we did nothing, because "nothing happened" must never look like
// "it worked".
class UpdateApplier {
  constructor ({ getUpdate, platform = process.platform, arch = process.arch, target = process.env.APPIMAGE, exec = defaultExec, fetchImpl, onRelaunch = null, log = () => {} } = {}) {
    this._getUpdate = getUpdate
    this._platform = platform
    this._arch = arch
    this._target = target
    this._exec = exec
    this._fetchImpl = fetchImpl
    this._onRelaunch = onRelaunch
    this._log = log
    this._state = { status: 'idle' }
  }

  getState () { return { ...this._state } }

  async apply () {
    const update = typeof this._getUpdate === 'function' ? this._getUpdate() : null
    if (!update || !update.available) {
      this._state = { status: 'no-update' }
      return this.getState()
    }
    // One at a time. A second click while a 130MB download is in flight must not
    // start a second download over the top of the first.
    if (this._state.status === 'running') return this.getState()
    this._state = { status: 'running', version: update.latest }

    // Every failure below lands here: the operator is offered the release page,
    // which is exactly what the banner did before this feature existed. Falling
    // back to "download it yourself" is always available and never wrong.
    const manual = { status: 'needs-manual', version: update.latest, htmlUrl: update.htmlUrl || null }

    try {
      const plan = planApply(update, update.assets, { platform: this._platform, arch: this._arch, appImage: this._target })
      const { file, digest } = await downloadAndVerify(plan, { fetchImpl: this._fetchImpl })
      this._log('update:verified', { version: plan.version, digest: digest.slice(0, 12) })

      const supervisor = await detectSupervisor({ platform: this._platform, exec: this._exec })
      const r = await applyUpdate(plan, { file, digest, supervisor, target: this._target, exec: this._exec, log: this._log })

      if (r.needsRelaunch) {
        this._state = { status: 'restarting', version: plan.version, via: 'self' }
        if (this._onRelaunch) this._onRelaunch()
      } else {
        this._state = { status: 'restarting', version: plan.version, via: r.via || 'supervisor' }
      }
    } catch (e) {
      // A verification failure is NOT the same as "not wired for this platform",
      // and the dashboard says so - one means something is wrong with the
      // download, the other means this platform simply cannot self-apply yet.
      this._state = e.code === 'NEEDS_MANUAL'
        ? { ...manual, reason: e.message }
        : { status: 'error', version: update.latest, error: e.message, htmlUrl: update.htmlUrl || null }
      this._log('update:apply-failed', { error: e.message })
    }
    return this.getState()
  }
}

module.exports = {
  VerifyError, NeedsManualError, UpdateApplier, defaultExec, selectAsset, planApply, downloadAndVerify,
  download, sha256File, parseSha256Sidecar, detectSupervisor, applyUpdate, APPLIERS, UNIT, WIN_SERVICE
}
