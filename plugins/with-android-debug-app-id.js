// Expo config plugin: give the debug buildType an applicationId suffix so debug
// installs are com.pearlist.debug while release stays com.pearlist. PearList
// regenerates android/ from app.json + config plugins on every `expo prebuild`
// (android/ is gitignored, no custom native code), so a hand-edit to
// build.gradle would be wiped on the next prebuild. This plugin is the durable
// source of truth.
//
// Why: debug and release then install under distinct package ids and can coexist
// on a device without a signature-mismatch conflict, and a debug build can never
// masquerade as the release package. Release naming (com.pearlist) is produced
// only by a release build, never by a plain `expo run:android` / debug build.
//
// The suffix changes only the applicationId, not the namespace (com.pearlist),
// so .MainActivity / .MainApplication and all fixed deep-link schemes and hosts
// resolve unchanged. Library FileProviders keyed on ${applicationId} self-adjust
// to com.pearlist.debug.provider.

const { withAppBuildGradle } = require('expo/config-plugins')

module.exports = function withAndroidDebugAppId (config) {
  return withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents

    // Anchor on the debug buildType (not the signingConfigs debug block, which
    // opens with storeFile). `buildTypes {` is unique, so this matches once.
    const anchor = /( {4}buildTypes \{\n {8}debug \{\n)/
    if (anchor.test(contents) && !contents.includes('applicationIdSuffix ".debug"')) {
      contents = contents.replace(
        anchor,
        '$1            applicationIdSuffix ".debug"\n'
      )
    }

    cfg.modResults.contents = contents
    return cfg
  })
}
