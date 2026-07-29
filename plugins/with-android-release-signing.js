// Expo config plugin: wire a real release signingConfig into the generated
// android/app/build.gradle.
//
// Without this, the Expo template points buildTypes.release at signingConfigs
// .debug, so `./gradlew assembleRelease` produces a DEBUG-SIGNED release APK.
// That builds and installs fine, which is what makes it dangerous: publish one
// to Play or Zapstore and the app's identity is bound to a throwaway key,
// permanently. scripts/release.sh checks the signature with apksigner and
// refuses to continue if this plugin has not taken effect.
//
// The injected `release` signingConfig reads its credentials from the
// environment first, then from Gradle properties (~/.gradle/gradle.properties
// or -P flags), so the keystore and passwords never live in the repo. If none
// are configured the release build falls back to the debug keystore, which
// keeps a local `assembleRelease` working without the keystore.
//
// Credentials (env var or Gradle property, the same names release.sh exports):
//   KEYSTORE_FILE      absolute path to the .jks upload keystore
//   KEYSTORE_PASSWORD  keystore (store) password
//   KEY_ALIAS          key alias inside the keystore
//   KEY_PASSWORD       key password
//
// android/ is BOTH committed and regenerated here (see CLAUDE.md), so this
// plugin is the source and the committed build.gradle is its output: edit this
// file, run `npx expo prebuild -p android`, and commit the result. It must also
// be idempotent, because prebuild runs it against an already-generated tree -
// hence the guards below. test/release-signing.test.js asserts the two agree.

const { withAppBuildGradle } = require('expo/config-plugins')

const RELEASE_SIGNING_CONFIG = `        release {
            def ksFile = System.getenv("KEYSTORE_FILE") ?: findProperty("KEYSTORE_FILE")
            def ksPassword = System.getenv("KEYSTORE_PASSWORD") ?: findProperty("KEYSTORE_PASSWORD")
            def kAlias = System.getenv("KEY_ALIAS") ?: findProperty("KEY_ALIAS")
            def kPassword = System.getenv("KEY_PASSWORD") ?: findProperty("KEY_PASSWORD")
            if (ksFile && ksPassword && kAlias && kPassword) {
                storeFile file(ksFile)
                storePassword ksPassword
                keyAlias kAlias
                keyPassword kPassword
            }
        }
`

const RELEASE_SIGNING_CONFIG_SENTINEL = 'def ksFile = System.getenv'

module.exports = function withAndroidReleaseSigning (config) {
  return withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents

    // 1. Add a `release` signingConfig next to the template's `debug` one.
    //    Anchor on the end of the debug block + close of signingConfigs.
    const signingAnchor = /(keyPassword 'android'\n {8}}\n)( {4}}\n)/
    if (signingAnchor.test(contents) && !contents.includes(RELEASE_SIGNING_CONFIG_SENTINEL)) {
      contents = contents.replace(
        signingAnchor,
        `$1${RELEASE_SIGNING_CONFIG}$2`
      )
    }

    // 2. Point the release buildType at the release signingConfig when a real
    //    keystore is configured, else keep the debug fallback. The "Caution!"
    //    comment's trailing line uniquely identifies the release buildType,
    //    not the debug one. Already-rewritten trees no longer match, so this
    //    is a no-op on a second prebuild.
    contents = contents.replace(
      /(\/\/ see https:\/\/reactnative\.dev\/docs\/signed-apk-android\.\n {12}signingConfig )signingConfigs\.debug/,
      '$1signingConfigs.release.storeFile ? signingConfigs.release : signingConfigs.debug'
    )

    cfg.modResults.contents = contents
    return cfg
  })
}

module.exports.RELEASE_SIGNING_CONFIG = RELEASE_SIGNING_CONFIG
module.exports.RELEASE_SIGNING_CONFIG_SENTINEL = RELEASE_SIGNING_CONFIG_SENTINEL
