// When is a host "fresh"? The first-run wizard opens on its own answer to that,
// so the rule lives here as a plain function: no React, no DOM, unit-testable.
//
// The rule reads only what /api/state already carries, on purpose. Storing a
// "setup completed" flag on the HOST would be a new persisted field for something
// the existing data already says - a host that has a source the operator chose, or
// a device that has paired, has plainly been set up. The one thing the data cannot
// tell us is "I looked at the wizard and closed it", which is a per-browser
// preference and belongs in localStorage (below), not in the host's data dir.

export const DEFAULT_LIBRARY_NAME = 'My Library'

// Fresh = nobody has ever paired AND the operator has never chosen a music source.
// `source.from` is the host's own precedence answer: 'dashboard' means the operator
// picked it, 'env' means the container was started with one, 'default' means we fell
// back to /music. Only 'dashboard' is a deliberate choice, so an env-configured host
// with no devices still gets walked to the pairing step.
export function needsSetup (state) {
  if (!state || !state.stats) return false
  const paired = (state.devices || []).length > 0
  const sourceChosen = !!(state.source && state.source.from === 'dashboard')
  return !paired && !sourceChosen
}

// Which steps this host should be walked through. The password step is dropped when
// there is nothing to change: a loopback host has no gate ('none'), and a
// platform-set password ('explicit') must be changed where the platform sets it.
export function setupSteps (state) {
  const src = state && state.passwordSource
  const wantsPassword = src === 'generated' || src === 'file'
  return ['welcome', 'name', 'source', ...(wantsPassword ? ['password'] : []), 'pair', 'done']
}

const KEY = 'peartune.setup.dismissed'

export function setupDismissed () {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export function dismissSetup () {
  try { localStorage.setItem(KEY, '1') } catch {}
}

// Re-running it from the gear menu clears the dismissal, so a host that is still
// unconfigured does not have the wizard suppressed on the next page load.
export function undismissSetup () {
  try { localStorage.removeItem(KEY) } catch {}
}
