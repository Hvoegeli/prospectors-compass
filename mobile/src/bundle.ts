// Loads an offline trip bundle (.pcbundle) into the app.
//
// A .pcbundle is a zip the desktop builds (see backend export/bundle.py):
//   trip.json       — manifest: the trip + waypoints, footprint bbox, the
//                     engine's scored cells, and basemap metadata.
//   terrain.mbtiles — the shaded-relief basemap clipped to the trip footprint.
//
// The load pipeline here is the REAL one we'll keep in production: copy the
// bundle bytes in, unzip them, write terrain.mbtiles out to the documents
// directory, and parse the manifest. The only piece stubbed until the phone
// arrives (for AirDrop) is WHERE the bundle comes from — in dev it's shipped as
// an app asset (FIXTURE below); in production the OS hands us the opened file
// and only that one line changes.

import { Asset } from 'expo-asset'
import { Directory, File, Paths } from 'expo-file-system'
import { strFromU8, unzipSync } from 'fflate'

export type Waypoint = {
  id: number
  lat: number
  lon: number
  kind?: string
  note?: string
  title?: string
  details?: string
}

// One scored grid cell from the engine. `geometry` is a GeoJSON Polygon encoded
// as a STRING (the desktop serializes it that way); we parse it when building the
// map's FeatureCollection. `factors`/`gates` are the "why it scored" breakdown.
export type ScoredCell = {
  lon: number
  lat: number
  geometry: string
  score: number
  band?: string
  factors?: Record<string, unknown>
  gates?: Record<string, unknown>
}

export type TripManifest = {
  format: string
  version: number
  exported_at: string
  trip: { id: number; name: string; waypoints: Waypoint[] }
  footprint: { bbox: [number, number, number, number]; buffer_mi: number }
  scored_areas: {
    target: string
    profile: string
    cell_size_m: number
    count: number
    cells: ScoredCell[]
  }
  basemap: {
    file: string
    format: string
    tile_size: number
    minzoom: number
    maxzoom: number
    bounds: string
  } | null
}

export type LoadedTrip = {
  manifest: TripManifest
  /** `mbtiles://` URL for the offline basemap RasterSource — null if the bundle
   *  carried no basemap (the trip still works, just without a map). */
  basemapMbtilesUrl: string | null
}

const TRIP_DIR = 'trip'
const MANIFEST_NAME = 'trip.json'
const BASEMAP_NAME = 'terrain.mbtiles'

// DEV stand-in for an AirDropped bundle: a real .pcbundle shipped as an app
// asset. In production this require() is replaced by the opened file's URI.
const FIXTURE = require('../assets/fixture.pcbundle')

// MapLibre's mbtiles:// scheme wants a bare absolute path after the scheme, NOT
// a file:// URI. documentDirectory URIs look like file:///var/...; strip that so
// we get mbtiles:///var/.../terrain.mbtiles (the triple slash is correct — it's
// the scheme plus an absolute path that itself begins with "/").
function mbtilesUrlFor(file: File): string {
  return `mbtiles://${file.uri.replace(/^file:\/\//, '')}`
}

export async function loadTripBundle(): Promise<LoadedTrip> {
  const tripDir = new Directory(Paths.document, TRIP_DIR)
  const manifestFile = new File(tripDir, MANIFEST_NAME)
  const basemapFile = new File(tripDir, BASEMAP_NAME)

  // Already unpacked on a previous launch — just read the manifest back.
  if (manifestFile.exists) {
    const manifest = JSON.parse(manifestFile.textSync()) as TripManifest
    return {
      manifest,
      basemapMbtilesUrl: basemapFile.exists ? mbtilesUrlFor(basemapFile) : null,
    }
  }

  // First run: unpack the bundle into the documents directory.
  if (!tripDir.exists) tripDir.create({ idempotent: true })

  const asset = Asset.fromModule(FIXTURE)
  await asset.downloadAsync() // makes asset.localUri a readable file:// path
  const zipBytes = new File(asset.localUri ?? asset.uri).bytesSync()
  const entries = unzipSync(zipBytes)

  const manifestBytes = entries[MANIFEST_NAME]
  if (!manifestBytes) throw new Error('bundle is missing trip.json')
  const manifestText = strFromU8(manifestBytes)
  const manifest = JSON.parse(manifestText) as TripManifest
  manifestFile.create({ overwrite: true })
  manifestFile.write(manifestText)

  let basemapMbtilesUrl: string | null = null
  const basemapBytes = entries[BASEMAP_NAME]
  if (basemapBytes) {
    basemapFile.create({ overwrite: true })
    basemapFile.write(basemapBytes)
    basemapMbtilesUrl = mbtilesUrlFor(basemapFile)
  }

  return { manifest, basemapMbtilesUrl }
}

// Build the map overlays from the manifest. Kept here (not in the component) so
// the parsing/shape logic is unit-testable and the component stays declarative.

/** Scored cells → a Polygon FeatureCollection carrying score + band for styling. */
export function scoredCellsFC(manifest: TripManifest): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  for (const cell of manifest.scored_areas.cells) {
    let geometry: GeoJSON.Geometry
    try {
      geometry = JSON.parse(cell.geometry) as GeoJSON.Geometry
    } catch {
      continue // skip a malformed cell rather than crash the whole map
    }
    features.push({
      type: 'Feature',
      geometry,
      properties: { score: cell.score, band: cell.band ?? '' },
    })
  }
  return { type: 'FeatureCollection', features }
}

/** Waypoints → a Point FeatureCollection carrying the title/kind for the markers. */
export function waypointsFC(manifest: TripManifest): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: manifest.trip.waypoints
      .filter((w) => typeof w.lon === 'number' && typeof w.lat === 'number')
      .map((w) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
        properties: { id: w.id, title: w.title ?? '', kind: w.kind ?? '' },
      })),
  }
}
