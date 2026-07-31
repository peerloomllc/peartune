// Should the "a new PearTune is out" banner render, and has this operator already
// waved it away? No React, no DOM, so the rule is unit-testable (test/update-ui.test.js).
//
// The banner is NOTIFY ONLY - it links to the release page and nothing more. The host
// half (host/update-check.js) explains why: a dashboard that downloads and swaps its
// own installer needs a privileged helper per platform, and the seeder's own comments
// say that part is still unwritten.

const KEY = 'peartune.update.dismissed'

// Dismissal is PER VERSION, not a permanent off switch. Waving away 1.0.1 must not
// also silence 1.1.0 - otherwise the one dismissal an operator makes today swallows
// every release after it, which is how a notifier quietly stops notifying.
export function dismissedVersion () {
  try { return localStorage.getItem(KEY) || null } catch { return null }
}

export function dismissUpdate (version) {
  try { localStorage.setItem(KEY, String(version || '')) } catch {}
}

// `info` is whatever GET /api/update answered. Every uncertain shape - not yet checked,
// GitHub down, container install, a version we cannot parse - lands on false, because a
// banner that is wrong is worse than no banner (host/update-check.js).
export function shouldShowUpdate (info, dismissed = dismissedVersion()) {
  if (!info || info.disabled || !info.available) return false
  if (!info.latest) return false
  return String(info.latest) !== String(dismissed)
}
