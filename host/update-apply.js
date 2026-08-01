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

module.exports = { VerifyError, selectAsset, planApply, downloadAndVerify, download, sha256File, parseSha256Sidecar }
