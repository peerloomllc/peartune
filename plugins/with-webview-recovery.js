// GrapheneOS / Vanadium WebView resume-freeze recovery: the native half.
//
// THE BUG. Android's cached-app freezer cgroup-freezes the WebView's out-of-process Vanadium
// renderer while the app is backgrounded. Since the 2026-07-19 Vanadium 151 update, on resume the
// app gets a NEW window surface but the thawed renderer's compositor never re-attaches to it, so it
// produces zero new buffers: a frozen screen, while React, JS, taps and haptics all still work
// (they live in the app process, which is healthy). Proven from live logcat on the Pixel; see
// /home/tim/peerloomllc/WEBVIEW_FREEZE_FIX_PORT.md and PearCircle PR #165.
//
// THE FIX. Only a FRESH render process recovers it - which is why the earlier remount attempt
// (#110) failed: a view-remount rebinds the SAME pooled, stale renderer. WebViewRenderProcess
// .terminate() (API 29+, and our minSdk is 29) kills just this app's renderer; the JS
// onRenderProcessGone handler then reloads into a fresh one bound to the current surface.
//
// WHY A CONFIG PLUGIN, correctly stated (2026-07-22). The original note here claimed android/ is
// gitignored in this repo. IT IS NOT: `git ls-files android` returns 47 tracked files, these two .kt
// among them, and .gitignore has no android entry. So the setup is prebuild-and-commit - the plugin
// is the SOURCE, and android/ holds its committed OUTPUT, which is what lets `./gradlew
// assembleDebug` work with no prebuild step.
//
// The plugin still earns its place: `expo prebuild` regenerates the tree, and without it this
// module would be dropped on the next prebuild - a P0 fix silently deleted by a routine command.
// What the false premise cost was clarity: it read as "android/ is disposable", which invites
// someone to edit the committed .kt (the obvious place) and have the next prebuild overwrite it.
// test/webview-recovery.test.js now fails if the committed copies drift from these templates.

const { withDangerousMod, withMainApplication } = require('expo/config-plugins')
const { MODULE_KT, PACKAGE_KT, REGISTER_CALL } = require('./webview-recovery-source')
const fs = require('fs')
const path = require('path')

// Write the two .kt files into the generated android tree.
const withWebViewRecoverySource = (config) =>
  withDangerousMod(config, ['android', (cfg) => {
    const pkg = cfg.android?.package
    if (!pkg) throw new Error('with-webview-recovery: no android.package in app.json')
    const dir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java', ...pkg.split('.'))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'WebViewRecoveryModule.kt'), MODULE_KT(pkg))
    fs.writeFileSync(path.join(dir, 'WebViewRecoveryPackage.kt'), PACKAGE_KT(pkg))
    return cfg
  }])

// Register the package with React Native. The generated MainApplication.kt builds its list as
// `PackageList(this).packages.apply { ... }` with a commented example inside - we add ours there.
// Idempotent: prebuild runs this every time, and a second `add(...)` would register the module
// twice (RN throws on a duplicate module name, so this would be a launch crash, not a warning).
const withWebViewRecoveryRegistered = (config) =>
  withMainApplication(config, (cfg) => {
    const ADD = REGISTER_CALL
    if (cfg.modResults.contents.includes(ADD)) return cfg

    const APPLY = /PackageList\(this\)\.packages\.apply\s*\{/
    if (!APPLY.test(cfg.modResults.contents)) {
      throw new Error('with-webview-recovery: no PackageList(...).packages.apply { } in MainApplication')
    }
    cfg.modResults.contents = cfg.modResults.contents.replace(
      APPLY,
      (m) => `${m}\n              // GrapheneOS WebView resume-freeze recovery (plugins/with-webview-recovery.js).\n              ${ADD}`
    )
    return cfg
  })

module.exports = (config) => withWebViewRecoveryRegistered(withWebViewRecoverySource(config))
