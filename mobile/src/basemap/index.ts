// Offline topo basemap loader.
//
// The statewide vector base (colorado.mbtiles, ~337 MB) is too big to embed in
// the app, so it's SIDELOADED onto the device into Documents/basemap/. The glyph
// fonts (tiny) live in Documents/fonts/<fontstack>/<range>.pbf. When both are
// present, we render the topo style (roads/water/land/labels); when they're not,
// the map falls back to the per-trip raster hillshade alone.
//
// Loading the file onto the device is decoupled from rendering: in dev we push
// it straight into the app's sandbox with `xcrun devicectl device copy to`; in
// production the user imports it once via the Files app. Either way it lands in
// the same Documents/basemap/ path this module reads.

import type { StyleSpecification } from '@maplibre/maplibre-react-native'
import { Directory, File, Paths } from 'expo-file-system'
import { buildTopoStyle, type HillshadeLayer } from './topoStyle'

// Must match the font stack name referenced in topoStyle.ts AND the on-device
// directory name (MapLibre requests glyphs by this exact fontstack string).
const FONT_STACK = 'Noto Sans Regular'
const VECTOR_NAME = 'colorado.mbtiles'

function baseDir(): Directory {
  return new Directory(Paths.document, 'basemap')
}
function fontsDir(): Directory {
  return new Directory(Paths.document, 'fonts')
}

/** Create the sideload target directories if missing, so the base map + fonts
 *  can be pushed into Documents/basemap and Documents/fonts before first use.
 *  Safe to call on every launch. */
export function ensureBasemapDirs(): void {
  for (const d of [baseDir(), fontsDir()]) {
    try {
      if (!d.exists) d.create({ intermediates: true, idempotent: true })
    } catch {
      // best-effort; absence just means the topo base stays unavailable
    }
  }
}

/** The offline topo style IF the statewide vector base AND the glyph fonts are
 *  both present on the device; otherwise null (caller falls back to raster).
 *  Pass the trip's per-trip hillshade to render shaded relief under the topo. */
export function topoStyleIfAvailable(hillshade?: HillshadeLayer | null): StyleSpecification | null {
  const vector = new File(baseDir(), VECTOR_NAME)
  const glyphSample = new File(fontsDir(), `${FONT_STACK}/0-255.pbf`)
  if (!vector.exists || !glyphSample.exists) return null
  // mbtiles:// wants a bare absolute path (strip file://); glyphs uses a file://
  // template MapLibre fills in per {fontstack}/{range}. fontsDir().uri ends in a
  // slash, so the concatenation yields .../fonts/{fontstack}/{range}.pbf.
  const vectorUrl = `mbtiles://${vector.uri.replace(/^file:\/\//, '')}`
  const glyphsUrl = `${fontsDir().uri}{fontstack}/{range}.pbf`
  return buildTopoStyle(vectorUrl, glyphsUrl, hillshade)
}
