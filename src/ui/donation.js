// When does the two-week donation nudge fire? The timing rule lives here as a pure
// function so it is unit-testable and stated once - a UI effect calls it, the tests
// pin its edges.
//
// The rule reads only settings the worklet already persists (firstRunAt stamped on
// first init; donationNudgeShown set when the nudge is answered). No new host state.

export const NUDGE_AFTER_MS = 14 * 24 * 60 * 60 * 1000 // two weeks

// Show the nudge when ALL hold:
//  - a host is paired (land on someone who has USED PearTune, not the pairing wall)
//  - it has never been answered
//  - first run was at least two weeks ago (and firstRunAt is a real stamp, not 0)
//
// iOS is no longer excluded: 1.0.0 shipped through App Review with the donation
// surface hidden as a launch precaution, and Tim turned it on for every platform on
// 2026-08-16. The `ios` field is still accepted (and ignored) so older callers and
// tests need no signature change.
export function shouldShowNudge ({ settings, host, ios, now }) {
  if (!host) return false
  if (!settings || settings.donationNudgeShown) return false
  const first = Number(settings.firstRunAt) || 0
  if (!first) return false
  return now - first >= NUDGE_AFTER_MS
}
