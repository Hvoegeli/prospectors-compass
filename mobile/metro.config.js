// Metro bundler config. Extends Expo's default so we can ship a `.pcbundle`
// (the offline trip package) as a bundled asset during development — Metro only
// serves files whose extension is in `assetExts`. In production the real bundle
// arrives via AirDrop/file-open instead; this is just the dev stand-in.
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
config.resolver.assetExts.push('pcbundle')
// `.pbf` glyph fonts are bundled in the app (assets/fonts) so the topo labels can
// be restored into Documents/fonts even after a clean reinstall — see ensureFonts.
config.resolver.assetExts.push('pbf')

module.exports = config
