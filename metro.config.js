const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
config.resolver.assetExts.push('bundle')
// The demo album cover (assets/demo-music/cover.bin) is JPEG data deliberately NOT named .jpg.
// React Native's Android asset packager routes recognised image types into res/drawable-*, where
// they are Android RESOURCES and expo-asset can only hand back a resource name - not a path any
// filesystem call can open, which is exactly how the first build failed (`ENOENT ...
// assets_demomusic_cover`). Anything it does not recognise goes to res/raw instead and copies out
// to a real file, which is what the worklet needs in order to read the bytes into the art store.
// The .mp3s land there already; the cover has to join them. See assets/demo-music/LICENSE.md.
config.resolver.assetExts.push('bin')

module.exports = config
