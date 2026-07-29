// Expo config plugin: let the release build set versionCode / versionName from
// the environment.
//
// WHY THIS IS NEEDED HERE AND NOT IN THE SIBLING APPS
//
// Normally `expo prebuild` writes app.json's version and versionCode straight
// into build.gradle, so bumping app.json is enough. PearList and PearPetal
// gitignore android/ and prebuild on every release, so that is exactly what
// happens there.
//
// PearTune commits android/ (see CLAUDE.md) and its release step 2 is therefore
// a deliberate no-op. So the release bumps app.json and build.gradle keeps
// saying whatever it said at the last prebuild - meaning the APK ships with a
// stale versionName while the tag, the release notes, the GitHub release and
// the Nostr announcement all say the new one. Play rejects a duplicate
// versionCode; Zapstore does not, and would happily publish "v0.2.0" containing
// 0.1.0.
//
// So scripts/release.sh exports these around the gradle invocation:
//
//   APP_VERSION       X.Y.Z, becomes versionName
//   APP_VERSION_CODE  major*1000000 + minor*1000 + patch, becomes versionCode
//
// A Gradle property of the same name works too. With neither set, the values
// prebuild wrote stand, so a plain `./gradlew assembleDebug` from a fresh
// checkout is unaffected.
//
// WHY THIS APPENDS AN OVERRIDE RATHER THAN REWRITING THE TWO LINES
//
// The obvious implementation replaces `versionCode 1` / `versionName "0.1.0"`
// with expressions that read the env. It works once and then corrupts itself:
// Expo's own version mod rewrites the FIRST `versionCode.*` and `versionName.*`
// it finds, so on the next prebuild it overwrites whatever this plugin put
// there and the result is a half-patched block (measured 2026-07-29:
// `versionCode 1` came back while `versionName resolvedAppVersion` stayed).
//
// Leaving those lines alone as plain defaults and overriding AFTER them means
// Expo's mod keeps ownership of what it owns, both plugins are stable across
// repeated prebuilds, and the sentinel check below makes re-insertion a no-op.
// android/ is both committed and regenerated here, so idempotency is not
// optional - see the nine duplicated <queries> blocks in CLAUDE.md.
//
// test/release-signing.test.js asserts the committed build.gradle agrees.

const { withAppBuildGradle } = require('expo/config-plugins')

// Anchored on the versionName line Expo emits, which is immediately below
// versionCode. Keep the capture so the override lands after both.
const VERSION_ANCHOR = /^( +)versionName "[^"]*"$/m

const VERSION_SENTINEL = 'def envAppVersion = System.getenv'

const VERSION_OVERRIDE = (indent) => [
  '',
  `${indent}// Release override, injected by plugins/with-android-version-from-env.js.`,
  `${indent}// The two lines above are the prebuild-time default: scripts/release.sh bumps`,
  `${indent}// app.json without prebuilding (android/ is committed), so it exports these`,
  `${indent}// instead. Unset in normal development, where the defaults stand.`,
  `${indent}def envAppVersion = System.getenv("APP_VERSION") ?: project.findProperty("APP_VERSION")`,
  `${indent}def envAppVersionCode = System.getenv("APP_VERSION_CODE") ?: project.findProperty("APP_VERSION_CODE")`,
  `${indent}if (envAppVersion) { versionName envAppVersion.toString() }`,
  `${indent}if (envAppVersionCode) { versionCode envAppVersionCode.toString().toInteger() }`
].join('\n')

module.exports = function withAndroidVersionFromEnv (config) {
  return withAppBuildGradle(config, (cfg) => {
    const contents = cfg.modResults.contents
    if (contents.includes(VERSION_SENTINEL)) return cfg

    const m = contents.match(VERSION_ANCHOR)
    if (!m) return cfg

    cfg.modResults.contents = contents.replace(
      VERSION_ANCHOR,
      (line) => line + VERSION_OVERRIDE(m[1])
    )
    return cfg
  })
}

module.exports.VERSION_SENTINEL = VERSION_SENTINEL
