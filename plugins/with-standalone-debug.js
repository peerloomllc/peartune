// Embed the JS bundle in DEBUG builds, so a test APK is standalone.
//
// By default React Native treats `debug` as a "debuggable variant": it does NOT
// bundle the JS, and the app expects a Metro dev server on the machine that
// built it. A tester with that APK on their phone gets a red screen the moment
// they walk out of wifi range of your laptop.
//
// Suite-wide rule (see PearGuard / PearPetal / PearList): test builds must be
// STANDALONE - JS embedded, no Metro - and carry a `.debug`-suffixed app id so
// they can sit alongside the production app. `debuggableVariants = []` says "no
// variant is Metro-served", which makes the debug build bundle its JS like a
// release one.
//
// This lives in a config plugin rather than a hand edit to android/app/build.gradle
// because `expo prebuild --clean` regenerates that file and would silently throw
// the edit away - and the failure only shows up later, on someone else's phone.

const { withAppBuildGradle } = require('expo/config-plugins')

// Operate line-wise and skip comments. The RN template SHIPS a commented example
// (`// debuggableVariants = ["liteDebug", "prodDebug"]`), and a naive regex over
// the whole file happily "edits" that comment, changes nothing real, and leaves
// you with a Metro-dependent APK that looks like it was fixed.
const ACTIVE_SETTING = /^\s*debuggableVariants\s*=/
const isComment = (line) => /^\s*(\/\/|\/\*|\*)/.test(line)

const withStandaloneDebug = (config) =>
  withAppBuildGradle(config, (cfg) => {
    const lines = cfg.modResults.contents.split('\n')

    const existing = lines.findIndex(l => ACTIVE_SETTING.test(l) && !isComment(l))
    if (existing !== -1) {
      lines[existing] = '    debuggableVariants = []'
      cfg.modResults.contents = lines.join('\n')
      return cfg
    }

    const reactBlock = lines.findIndex(l => /^\s*react\s*\{/.test(l) && !isComment(l))
    if (reactBlock === -1) {
      throw new Error('with-standalone-debug: no react { } block in app/build.gradle')
    }

    lines.splice(
      reactBlock + 1,
      0,
      '    // PearTune: bundle JS into debug builds so test APKs are standalone (no Metro).',
      '    debuggableVariants = []'
    )
    cfg.modResults.contents = lines.join('\n')
    return cfg
  })

module.exports = withStandaloneDebug
