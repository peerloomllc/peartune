// Expo config plugin: restrict the Android build to arm64-v8a. The Bare runtime
// ships native .so addons per ABI, so a universal APK (armeabi-v7a, arm64-v8a,
// x86, x86_64) is ~349MB; arm64-v8a alone is ~111MB and covers essentially all
// modern Android hardware (Google has required 64-bit since 2019). Baked into
// gradle.properties on prebuild so every build is trimmed without a flag.

const { withGradleProperties } = require('expo/config-plugins')

const ABIS = 'arm64-v8a'

module.exports = function withAndroidAbis (config) {
  return withGradleProperties(config, (cfg) => {
    const props = cfg.modResults
    const key = 'reactNativeArchitectures'
    const existing = props.find((p) => p.type === 'property' && p.key === key)
    if (existing) existing.value = ABIS
    else props.push({ type: 'property', key, value: ABIS })
    return cfg
  })
}
