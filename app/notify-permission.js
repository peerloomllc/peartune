// WHEN THE SHELL ASKS ANDROID FOR PERMISSION TO POST NOTIFICATIONS.
//
// The media notification - the now-playing card with play/pause and skip, and the
// one that carries the foreground service - is built by expo-audio the moment
// setActiveForLockScreen runs. Android 13 (API 33) added POST_NOTIFICATIONS as a
// RUNTIME permission, and an app that never asks never gets it, so the card is
// built and then silently not shown. The service still runs; the user just sees
// nothing to tap (reported 2026-09-18, issue #438: "no notification icon with
// control buttons").
//
// Below 33 the permission is granted at install time and requesting it is a
// no-op, so the ask is gated on the API level rather than fired blindly.
//
// One ask per launch: Android stops showing the dialog by itself after the user
// refuses twice, and request() then resolves 'never_ask_again' without any UI.
// Re-asking on a LATER launch is deliberate, for the accidental first refusal.
//
// Its own file, like starve.js and openable.js beside it: app/index.tsx cannot be
// required from a node test, and a rule with no test is a rule that rots.

const POST_NOTIFICATIONS_SDK = 33

function shouldAskForNotifications ({ os, apiLevel, asked, permission } = {}) {
  if (os !== 'android') return false
  // The constant is missing on React Native versions that predate the permission.
  // Requesting an undefined permission throws, so treat absence as "cannot ask".
  if (!permission) return false
  if (asked) return false
  return Number(apiLevel) >= POST_NOTIFICATIONS_SDK
}

module.exports = { shouldAskForNotifications, POST_NOTIFICATIONS_SDK }
