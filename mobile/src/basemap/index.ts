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
import { Asset } from 'expo-asset'
import { Directory, File, Paths } from 'expo-file-system'
import { buildTopoStyle, type HillshadeLayer } from './topoStyle'

// Must match the font stack name referenced in topoStyle.ts AND the on-device
// directory name (MapLibre requests glyphs by this exact fontstack string).
const FONT_STACK = 'Noto Sans Regular'
const VECTOR_NAME = 'colorado.mbtiles'
const GLYPH_RANGE = '0-255.pbf'

// The single glyph range the topo labels need (Latin, 0-255), bundled INSIDE the
// app. The statewide vector base is too big to embed, but this ~74 KB file is not —
// shipping it lets the labels survive even a clean delete-and-reinstall (which
// wipes Documents/fonts), because ensureFonts restores it from the bundle.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BUNDLED_GLYPH = require('../../assets/fonts/noto-sans-regular-0-255.pbf') as number

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

/** Restore the bundled glyph into Documents/fonts/<stack>/<range> if it isn't
 *  already there, so the topo labels survive a clean reinstall (the font ships
 *  inside the app, not only as a sideloaded file). No-op once present. Best-effort:
 *  on failure the map just falls back to the raster base. Returns when done so the
 *  caller can (re)evaluate the topo style with the font guaranteed in place. */
export async function ensureFonts(): Promise<void> {
  try {
    const stackDir = new Directory(fontsDir(), FONT_STACK)
    const dest = new File(stackDir, GLYPH_RANGE)
    if (dest.exists) return
    const asset = Asset.fromModule(BUNDLED_GLYPH)
    await asset.downloadAsync() // for an embedded asset this just resolves localUri
    if (!asset.localUri) return
    if (!stackDir.exists) stackDir.create({ intermediates: true, idempotent: true })
    new File(asset.localUri).copy(dest)
  } catch {
    // best-effort restore; topo simply stays unavailable if it fails
  }
}

/** True if the path looks like an MBTiles basemap the user opened from Files. */
export function isBasemapUri(uri: string): boolean {
  return /\.mbtiles$/i.test(uri.split('?')[0])
}

/** Install a basemap the user opened from Files/AirDrop: copy the .mbtiles into
 *  Documents/basemap, replacing any existing one. This is the no-Mac restore path —
 *  after a reinstall, open your saved colorado.mbtiles to reinstall the topo base.
 *  Returns true on success. The vector base is large (~337 MB); File.copy streams
 *  it, so this doesn't load it into memory. */
export async function importBasemapFromUri(uri: string): Promise<boolean> {
  try {
    ensureBasemapDirs()
    const src = new File(uri)
    if (!src.exists) return false
    const dest = new File(baseDir(), VECTOR_NAME)
    if (dest.exists) dest.delete()
    src.copy(dest)
    return true
  } catch {
    return false
  }
}

/** Whether the statewide vector base is installed on the device (drives the
 *  "open a .mbtiles to install the topo base" hint when it's missing). */
export function hasVectorBase(): boolean {
  return new File(baseDir(), VECTOR_NAME).exists
}

/** The offline topo style IF the statewide vector base AND the glyph fonts are
 *  both present on the device; otherwise null (caller falls back to raster).
 *  Pass the trip's per-trip hillshade to render shaded relief under the topo. */
export function topoStyleIfAvailable(hillshade?: HillshadeLayer | null): StyleSpecification | null {
  const vector = new File(baseDir(), VECTOR_NAME)
  const glyphSample = new File(fontsDir(), `${FONT_STACK}/${GLYPH_RANGE}`)
  if (!vector.exists || !glyphSample.exists) return null
  // mbtiles:// wants a bare absolute path (strip file://); glyphs uses a file://
  // template MapLibre fills in per {fontstack}/{range}. fontsDir().uri ends in a
  // slash, so the concatenation yields .../fonts/{fontstack}/{range}.pbf.
  const vectorUrl = `mbtiles://${vector.uri.replace(/^file:\/\//, '')}`
  const glyphsUrl = `${fontsDir().uri}{fontstack}/{range}.pbf`
  return buildTopoStyle(vectorUrl, glyphsUrl, hillshade)
}
