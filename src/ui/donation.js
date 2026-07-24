// When does the two-week donation nudge fire? The timing rule lives here as a pure
// function so it is unit-testable and stated once - a UI effect calls it, the tests
// pin its edges.
//
// The rule reads only settings the worklet already persists (firstRunAt stamped on
// first init; donationNudgeShown set when the nudge is answered). No new host state.

export const NUDGE_AFTER_MS = 14 * 24 * 60 * 60 * 1000 // two weeks

// Show the nudge when ALL hold:
//  - not iOS (App Store 3.1.1 forbids external donation links; the whole donation
//    surface is hidden there, so a nudge pointing at it would dead-end)
//  - a host is paired (land on someone who has USED PearTune, not the pairing wall)
//  - it has never been answered
//  - first run was at least two weeks ago (and firstRunAt is a real stamp, not 0)
export function shouldShowNudge ({ settings, host, ios, now }) {
  if (ios) return false
  if (!host) return false
  if (!settings || settings.donationNudgeShown) return false
  const first = Number(settings.firstRunAt) || 0
  if (!first) return false
  return now - first >= NUDGE_AFTER_MS
}
