// Store-screenshot scenes: writes the native module into the generated android tree and
// registers it. Same shape as with-webview-recovery.js, for the same reason - android/ here is
// prebuild-and-COMMIT, so the plugin is the source and the committed .kt is its output. Without
// the plugin, the next `expo prebuild` would silently delete the module.
//
// Idempotent, and that matters: prebuild runs against an ALREADY generated tree, so an
// unconditional add() would register the package twice, and React Native throws on a duplicate
// module name - a launch crash, not a warning. with-android-queries had appended itself nine times
// before anyone noticed (fixed 2026-07-22).

const { withDangerousMod, withMainApplication } = require('expo/config-plugins')
const { MODULE_KT, PACKAGE_KT, REGISTER_CALL } = require('./screenshot-scene-source')
const fs = require('fs')
const path = require('path')

const withScreenshotSceneSource = (config) =>
  withDangerousMod(config, ['android', (cfg) => {
    const pkg = cfg.android?.package
    if (!pkg) throw new Error('with-screenshot-scene: no android.package in app.json')
    const dir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java', ...pkg.split('.'))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'ScreenshotModule.kt'), MODULE_KT(pkg))
    fs.writeFileSync(path.join(dir, 'ScreenshotPackage.kt'), PACKAGE_KT(pkg))
    return cfg
  }])

const withScreenshotSceneRegistered = (config) =>
  withMainApplication(config, (cfg) => {
    if (cfg.modResults.contents.includes(REGISTER_CALL)) return cfg

    const APPLY = /PackageList\(this\)\.packages\.apply\s*\{/
    if (!APPLY.test(cfg.modResults.contents)) {
      throw new Error('with-screenshot-scene: no PackageList(...).packages.apply { } in MainApplication')
    }
    cfg.modResults.contents = cfg.modResults.contents.replace(
      APPLY,
      (m) => `${m}\n              // Store-screenshot scenes (plugins/with-screenshot-scene.js).\n              ${REGISTER_CALL}`
    )
    return cfg
  })

module.exports = (config) => withScreenshotSceneRegistered(withScreenshotSceneSource(config))
