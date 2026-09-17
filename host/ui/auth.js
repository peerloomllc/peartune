// The lock on the control plane.
//
// Proposal 2026-07-14-dashboard-auth (T3). Read that first; the short version is
// the chain of facts that forces this to exist:
//
//   the host needs network_mode: host (bridge NAT kills holepunching - measured,
//   twice) -> Umbrel's app_proxy cannot front a host-networked service -> the
//   proxy was the only thing standing in for our missing auth -> so the dashboard
//   needs its own.
//
// What this page can do, and therefore what this file is guarding: revoke any
// device instantly, mid-song; open a pairing window that grants a stranger the
// whole library; rename people. "Unauthenticated status page" is the wrong mental
// model. "Anyone on your wifi can take your music library" is the right one.


// ON @peerloom/host. The lock itself (sessions, lockout, the constant-time check,
// the fail-closed bind rule, 0600 on the password file) is the package's
// dashboard-auth, tested once there. What stays here is what is PearTune's: the app
// slug that names the session cookie, and the env var the refusal tells an operator
// to set.

const auth = require('@peerloom/host/dashboard-auth')

const APP = 'peartune'
const COOKIE = `${APP}_session`
const ENV_VAR = 'PEARTUNE_PASSWORD'

function createAuth (password) {
  return auth.createDashboardAuth({ app: APP, password, envVar: ENV_VAR })
}

function requireSafeBind (bind, password) {
  return auth.requireSafeBind(bind, password, { envVar: ENV_VAR })
}

module.exports = {
  createAuth,
  requireSafeBind,
  resolveDashboardPassword: auth.resolveDashboardPassword,
  generatePassword: auth.generatePassword,
  isLoopback: auth.isLoopback,
  MAX_FAILURES: auth.MAX_FAILURES,
  PASSWORD_FILE: auth.PASSWORD_FILE,
  COOKIE
}
