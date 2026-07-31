// "A new PearTune is out" for the host - notify only, never self-applies.
//
// Ported from PearCircle's seeder (seeder-launcher/host/updateCheck.js + the pure
// comparison in src/lib/seederUpdateCheck.js), with two deliberate differences:
//
//   * NOTIFY ONLY. PearCircle's slice 3 downloads and swaps the installer per platform,
//     and its own comments say the privileged helper for .deb and .pkg is still unwritten.
//     A banner that says "1.0.1 is out, here is the download" is most of the value for
//     none of the platform-specific risk, so that is all this does.
//   * ONE VERSION LINE. The seeder had a version of its own to compare. Everything PearTune
//     ships now moves together (Tim, 2026-07-31), so the host compares its own
//     package.json against the repo's latest release tag and the answer means something.
//     With the host at 0.2.4 and the tag at v1.0.0 - where this stood an hour ago - the
//     comparison was wrong in both directions and no banner could have been trusted.
//
// FAIL OPEN, ALWAYS. GitHub rate-limits unauthenticated callers to 60/hour and goes down
// like anything else. Every failure is recorded and returned as `error`; nothing here can
// stop a host serving music, which is the only job that matters.

const PUBLIC_REPO = 'peerloomllc/peartune'

// Hourly. Unauthenticated GitHub allows 60 requests an hour per IP and a host may sit
// behind a NAT shared with other hosts, so this is deliberately far below the ceiling.
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000

// `vX.Y.Z` or `X.Y.Z`, with any pre-release suffix ignored for ordering: `1.0.1-rc2`
// compares as 1.0.1. Good enough for "is there a newer release", which is the only
// question being asked.
function parseVersion (v) {
  if (typeof v !== 'string') return null
  const m = v.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!m) return null
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)]
}

function compareVersions (a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  return 0
}

// ERRS TOWARD "NO UPDATE". An unparseable version on either side returns false rather
// than true: a banner that cries wolf about a release that does not exist is worse than
// no banner, because the next real one is not believed.
function isNewer (latest, current) {
  if (!parseVersion(latest) || !parseVersion(current)) return false
  return compareVersions(latest, current) > 0
}

// Should this install check at all? Anything running inside a container gets its updates
// from the image and the store that pins it - Umbrel shows its own "update available" off
// the listing's version: field, and a second banner inside the dashboard telling the user
// to go and download an installer would be actively wrong there.
//
// /.dockerenv is what the seeder keys off and it is present in Docker and Podman alike.
// PEARTUNE_NO_UPDATE_CHECK turns it off anywhere else (packagers, distro builds).
// WHERE THE HOST'S OWN VERSION COMES FROM, which is not one place, because the host
// ships in three layouts that disagree about what `..` means:
//
//   source checkout   host/index.js  ->  ../package.json  = the repo root (1.0.0)
//   docker image      /app/host/...  ->  ../package.json  = host/package.json, copied
//                                                            to /app by the Dockerfile
//   desktop app       desktop/vendor/host/  ->  NEITHER EXISTS. prepack.js copies source
//                                                only and skips host/package*.json, so a
//                                                bare require('../package.json') THROWS
//                                                at startup and takes the tray app with it.
//
// So the desktop passes its version in (Electron's app.getVersion()), and this is the
// fallback for the other two. Null when nothing answers - the caller then runs no check
// at all rather than comparing against a version it had to invent.
function hostVersion ({ env = process.env, load = (p) => require(p) } = {}) {
  if (env.PEARTUNE_VERSION) return env.PEARTUNE_VERSION
  for (const p of ['../package.json', './package.json']) {
    try {
      const v = load(p).version
      if (v) return v
    } catch {}
  }
  return null
}

function updatesDisabled ({ env = process.env, fs = require('fs') } = {}) {
  if (env.PEARTUNE_NO_UPDATE_CHECK) return { disabled: true, reason: 'PEARTUNE_NO_UPDATE_CHECK' }
  try {
    if (fs.existsSync('/.dockerenv')) return { disabled: true, reason: 'container' }
  } catch {}
  return { disabled: false, reason: null }
}

// Shape the GitHub release JSON into the two facts the dashboard needs, and nothing else.
// `htmlUrl` rather than an asset: this notifies, it does not download.
function evaluateRelease (release, currentVersion) {
  if (!release || typeof release !== 'object') return { error: 'no release data' }
  if (release.draft || release.prerelease) return { available: false, current: currentVersion, reason: 'prerelease' }
  const latest = String(release.tag_name || release.name || '').trim()
  if (!latest) return { error: 'release has no tag' }
  return {
    available: isNewer(latest, currentVersion),
    current: currentVersion,
    latest: latest.replace(/^v/i, ''),
    htmlUrl: typeof release.html_url === 'string' ? release.html_url : null,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null
  }
}

class UpdateChecker {
  constructor ({ currentVersion, log = () => {}, repo = PUBLIC_REPO, intervalMs = DEFAULT_INTERVAL_MS, fetchImpl = null, url = null } = {}) {
    this.currentVersion = currentVersion
    this.log = log
    this.intervalMs = intervalMs
    this.url = url || process.env.PEARTUNE_UPDATE_LATEST_URL || `https://api.github.com/repos/${repo}/releases/latest`
    this.fetch = fetchImpl || globalThis.fetch
    this.state = { checkedAt: null, available: false, current: currentVersion }
    this.timer = null
  }

  get () { return { ...this.state } }

  async check () {
    try {
      const res = await this.fetch(this.url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `peartune-host/${this.currentVersion}` }
      })
      if (!res.ok) throw new Error(`github ${res.status}`)
      this.state = { ...evaluateRelease(await res.json(), this.currentVersion), checkedAt: Date.now() }
      if (this.state.available) this.log('update:available', { current: this.currentVersion, latest: this.state.latest })
    } catch (e) {
      // Keep whatever we last knew. A transient failure must not retract a banner that
      // was correct ten minutes ago.
      this.state = { ...this.state, error: e.message, checkedAt: Date.now() }
    }
    return this.get()
  }

  start () {
    this.check().catch(() => {})
    this.timer = setInterval(() => this.check().catch(() => {}), this.intervalMs)
    // A release check is not a reason to hold a process open.
    if (this.timer.unref) this.timer.unref()
    return this
  }

  stop () { if (this.timer) clearInterval(this.timer); this.timer = null }
}

// The one call every host front-end makes: "give me a checker, or null and the reason".
// Keeping the three refusals (container, opted out, no version) in one place is what
// stops the desktop and the daemon drifting into different answers.
function createUpdateChecker ({ currentVersion = null, log = () => {}, env = process.env, versionOf = hostVersion } = {}) {
  const off = updatesDisabled({ env })
  if (off.disabled) return { checker: null, reason: off.reason, version: currentVersion }
  const version = currentVersion || versionOf({ env })
  if (!version) return { checker: null, reason: 'unknown version', version: null }
  return { checker: new UpdateChecker({ currentVersion: version, log }).start(), reason: null, version }
}

module.exports = {
  UpdateChecker, createUpdateChecker, evaluateRelease, isNewer, compareVersions,
  parseVersion, updatesDisabled, hostVersion, DEFAULT_INTERVAL_MS
}
