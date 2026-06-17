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

// One weighted-overlay factor that fed a cell's score. `contribution` is already
// weight x membership, and ALL factors' contributions sum to score/100 — so
// `contribution * 100` reads directly as "points this factor added to the 0-100
// score" (the field-friendly way to show the rationale).
export type ScoreFactor = {
  name: string
  label: string
  raw: string
  membership: number
  weight: number
  contribution: number
}

// A pass/fail gate (land ownership, active claims). `gate` is a multiplier on the
// score: 1.0 = open/passes, < 1.0 = restricted and knocks the score down.
export type ScoreGate = {
  name: string
  gate: number
  raw: string
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
  factors?: ScoreFactor[]
  gates?: ScoreGate[]
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

const LEGACY_TRIP_DIR = 'trip' // pre-library single-trip location (migrated once)
const TRIPS_DIR = 'trips' // Documents/trips/<tripId>/ — one folder per trip
const ACTIVE_FILE = 'active-trip.json' // Documents/active-trip.json → { id }
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

// One folder per trip under Documents/trips/<id>/; the active trip id lives in
// Documents/active-trip.json. Importing ADDS a trip (keyed by its manifest id)
// and makes it active, rather than overwriting a single slot — so the phone
// holds a library of trips the user can switch between.

/** A lightweight trip descriptor for the picker (no cells/geometry loaded). */
export type TripSummary = {
  id: number
  name: string
  exportedAt: string
  center: [number, number] // footprint center [lon, lat]
  waypointCount: number
  scoredCount: number
}

function tripsRoot(): Directory {
  return new Directory(Paths.document, TRIPS_DIR)
}
function tripDir(id: number): Directory {
  return new Directory(tripsRoot(), String(id))
}
function activeFile(): File {
  return new File(Paths.document, ACTIVE_FILE)
}

function getActiveId(): number | null {
  const f = activeFile()
  if (!f.exists) return null
  try {
    const j = JSON.parse(f.textSync()) as { id?: unknown }
    return typeof j.id === 'number' ? j.id : null
  } catch {
    return null
  }
}

/** Make `id` the active trip (persisted across launches). */
export function setActiveTrip(id: number): void {
  const f = activeFile()
  f.create({ overwrite: true })
  f.write(JSON.stringify({ id }))
}

function loadedFromDir(dir: Directory): LoadedTrip {
  const manifest = JSON.parse(new File(dir, MANIFEST_NAME).textSync()) as TripManifest
  const basemapFile = new File(dir, BASEMAP_NAME)
  return { manifest, basemapMbtilesUrl: basemapFile.exists ? mbtilesUrlFor(basemapFile) : null }
}

// Unpack a .pcbundle's bytes into trips/<id>/ (keyed by the manifest's trip id,
// so re-importing the same trip updates it in place). Returns the id + load.
function unpackZipToTrips(zipBytes: Uint8Array): { id: number; loaded: LoadedTrip } {
  const entries = unzipSync(zipBytes)
  const manifestBytes = entries[MANIFEST_NAME]
  if (!manifestBytes) throw new Error('bundle is missing trip.json')
  const manifestText = strFromU8(manifestBytes)
  const manifest = JSON.parse(manifestText) as TripManifest
  const id = manifest.trip.id
  const dir = tripDir(id)
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true })

  const manifestFile = new File(dir, MANIFEST_NAME)
  manifestFile.create({ overwrite: true })
  manifestFile.write(manifestText)

  const basemapFile = new File(dir, BASEMAP_NAME)
  const basemapBytes = entries[BASEMAP_NAME]
  if (basemapBytes) {
    basemapFile.create({ overwrite: true })
    basemapFile.write(basemapBytes)
  } else if (basemapFile.exists) {
    basemapFile.delete()
  }
  return { id, loaded: loadedFromDir(dir) }
}

/** Import a .pcbundle the user opened/AirDropped: read it, add it to the library
 *  (keyed by trip id), make it active, and return the loaded trip. The real
 *  desktop→phone handoff (the fixture is only a dev stand-in). */
export async function importBundleFromUri(uri: string): Promise<LoadedTrip> {
  const src = new File(uri)
  const { id, loaded } = unpackZipToTrips(src.bytesSync())
  setActiveTrip(id)
  try {
    if (src.exists) src.delete() // best-effort cleanup of the inbox copy
  } catch {
    // harmless if the OS already reclaimed it
  }
  return loaded
}

/** Every trip stored on the phone, newest first. */
export function listTrips(): TripSummary[] {
  const root = tripsRoot()
  if (!root.exists) return []
  const out: TripSummary[] = []
  for (const entry of root.list()) {
    if (!(entry instanceof Directory)) continue
    const mf = new File(entry, MANIFEST_NAME)
    if (!mf.exists) continue
    try {
      const m = JSON.parse(mf.textSync()) as TripManifest
      const [w, s, e, n] = m.footprint.bbox
      out.push({
        id: m.trip.id,
        name: m.trip.name,
        exportedAt: m.exported_at,
        center: [(w + e) / 2, (s + n) / 2],
        waypointCount: m.trip.waypoints.length,
        scoredCount: m.scored_areas.count,
      })
    } catch {
      // skip an unreadable trip folder rather than break the whole list
    }
  }
  return out.sort((a, b) => (a.exportedAt < b.exportedAt ? 1 : -1))
}

/** Load one stored trip by id. */
export function loadTrip(id: number): LoadedTrip {
  return loadedFromDir(tripDir(id))
}

// Migrate the pre-library single-trip folder (Documents/trip) into the library
// once, so upgrading doesn't lose the trip already on the phone.
function migrateLegacyTrip(): void {
  const legacy = new Directory(Paths.document, LEGACY_TRIP_DIR)
  const legacyManifest = new File(legacy, MANIFEST_NAME)
  if (!legacyManifest.exists) return
  try {
    const m = JSON.parse(legacyManifest.textSync()) as TripManifest
    const dir = tripDir(m.trip.id)
    if (!dir.exists) {
      dir.create({ intermediates: true, idempotent: true })
      const destManifest = new File(dir, MANIFEST_NAME)
      destManifest.create({ overwrite: true })
      destManifest.write(legacyManifest.textSync())
      const legacyBase = new File(legacy, BASEMAP_NAME)
      if (legacyBase.exists) legacyBase.copy(new File(dir, BASEMAP_NAME))
      if (getActiveId() == null) setActiveTrip(m.trip.id)
    }
    legacy.delete() // remove so we don't migrate again
  } catch {
    // if migration fails, leave the legacy folder; the fixture still loads
  }
}

/** Load the active trip (or the most recent), seeding the library with the dev
 *  fixture on a fresh install. Replaces the old single-trip loader. */
export async function loadActiveOrFixture(): Promise<LoadedTrip> {
  migrateLegacyTrip()
  const trips = listTrips()
  if (trips.length > 0) {
    const activeId = getActiveId()
    const target = activeId != null && trips.some((t) => t.id === activeId) ? activeId : trips[0].id
    setActiveTrip(target)
    return loadTrip(target)
  }
  // Fresh install: seed the library with the bundled dev fixture.
  const asset = Asset.fromModule(FIXTURE)
  await asset.downloadAsync()
  const { id, loaded } = unpackZipToTrips(new File(asset.localUri ?? asset.uri).bytesSync())
  setActiveTrip(id)
  return loaded
}

// Build the map overlays from the manifest. Kept here (not in the component) so
// the parsing/shape logic is unit-testable and the component stays declarative.

/** Scored cells → a Polygon FeatureCollection carrying score + band for styling.
 *  Each feature also carries `idx`, its position in `manifest.scored_areas.cells`,
 *  so a map tap can look the FULL cell (factors/gates) back up in memory — the
 *  rich rationale objects don't survive the native press round-trip, but a plain
 *  integer index does. `idx` is the original cell index (skipped malformed cells
 *  don't shift it), so the lookup stays correct. */
export function scoredCellsFC(manifest: TripManifest): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  manifest.scored_areas.cells.forEach((cell, idx) => {
    let geometry: GeoJSON.Geometry
    try {
      geometry = JSON.parse(cell.geometry) as GeoJSON.Geometry
    } catch {
      return // skip a malformed cell rather than crash the whole map
    }
    features.push({
      type: 'Feature',
      geometry,
      properties: { idx, score: cell.score, band: cell.band ?? '' },
    })
  })
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
