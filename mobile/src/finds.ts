// Field finds: things the user discovers and logs ON the phone, in the field.
//
// A find is a waypoint-shaped record (so it round-trips cleanly into the trip's
// waypoints array on the desktop later — see backend Trip.waypoints) plus a
// `created_at` stamp. Finds are stored append-only in the documents directory,
// in their OWN file keyed by trip id (`finds-<tripId>.json`) so loading a new
// trip bundle can never overwrite finds logged on an earlier trip. Everything is
// local: no network, works with zero signal.

import { Directory, File, Paths } from 'expo-file-system'
import { strToU8, zipSync } from 'fflate'

export type Find = {
  id: number
  lon: number
  lat: number
  kind: string
  note: string
  created_at: string // ISO 8601
  photo?: string // relative filename in find-photos/<tripId>/, if a photo is attached
}

function findsFile(tripId: number): File {
  return new File(Paths.document, `finds-${tripId}.json`)
}

// A backup written BEFORE the main file on every save, holding the same new
// state. If a save is interrupted and leaves the main file truncated/corrupt,
// loadFinds recovers the full list from here — so a crash can never wipe the
// history (the worst case is losing the single find that was mid-write).
function findsBackup(tripId: number): File {
  return new File(Paths.document, `finds-${tripId}.bak.json`)
}

function parseFinds(f: File): Find[] | null {
  if (!f.exists) return null
  try {
    const parsed = JSON.parse(f.textSync()) as unknown
    return Array.isArray(parsed) ? (parsed as Find[]) : null
  } catch {
    return null // corrupt/truncated — signal "unreadable" so we try the backup
  }
}

/** All finds logged for this trip, oldest first. Empty if none yet. Falls back
 *  to the backup if the main file is missing or corrupt (interrupted write). */
export async function loadFinds(tripId: number): Promise<Find[]> {
  return parseFinds(findsFile(tripId)) ?? parseFinds(findsBackup(tripId)) ?? []
}

// Serialize all writes for one device so two rapid saves (or a save racing the
// trip-load) can't read the same base list and clobber each other — the second
// save waits for the first to finish, then reads the list WITH the first find.
let writeQueue: Promise<unknown> = Promise.resolve()

async function doAppendFind(tripId: number, find: Find): Promise<Find[]> {
  const updated = [...(await loadFinds(tripId)), find]
  const json = JSON.stringify(updated)
  // Backup first (complete new state), then the main file. Crash mid-main-write
  // → loadFinds recovers from the backup; crash mid-backup-write → the main file
  // still holds the previous complete state. Either way the history survives.
  const bak = findsBackup(tripId)
  bak.create({ overwrite: true })
  bak.write(json)
  const main = findsFile(tripId)
  main.create({ overwrite: true })
  main.write(json)
  return updated
}

/** Append one find (append-only, crash-safe, serialized) and return the list. */
export async function appendFind(tripId: number, find: Find): Promise<Find[]> {
  const run = writeQueue.then(() => doAppendFind(tripId, find))
  writeQueue = run.catch(() => undefined) // keep the chain alive past any error
  return run
}

async function doDeleteFind(tripId: number, findId: number): Promise<Find[]> {
  const current = await loadFinds(tripId)
  const removed = current.find((f) => f.id === findId)
  const updated = current.filter((f) => f.id !== findId)
  const json = JSON.stringify(updated)
  // Same backup-first, main-second order as doAppendFind: a crash mid-write still
  // recovers a complete list from one file or the other.
  const bak = findsBackup(tripId)
  bak.create({ overwrite: true })
  bak.write(json)
  const main = findsFile(tripId)
  main.create({ overwrite: true })
  main.write(json)
  // Drop the orphaned photo AFTER the list is safely rewritten. A crash in between
  // leaves a photo with no find (harmless, reclaimable) rather than a find pointing
  // at a deleted file. Best-effort: a failed delete just leaves an orphan.
  if (removed?.photo) {
    try {
      const photo = new File(photosDir(tripId), removed.photo)
      if (photo.exists) photo.delete()
    } catch {
      // orphaned photo is harmless; ignore
    }
  }
  return updated
}

/** Delete one find by id (crash-safe, serialized) and return the remaining list.
 *  Also removes the find's photo file if it had one. */
export async function deleteFind(tripId: number, findId: number): Promise<Find[]> {
  const run = writeQueue.then(() => doDeleteFind(tripId, findId))
  writeQueue = run.catch(() => undefined) // keep the chain alive past any error
  return run
}

// Per-trip photo directory: documents/find-photos/<tripId>/.
function photosDir(tripId: number): Directory {
  return new Directory(Paths.document, 'find-photos', String(tripId))
}

/** Copy a freshly captured photo (the picker's temp URI) into permanent per-trip
 *  storage, named by the find id. Returns the RELATIVE filename to store on the
 *  find, or null if the copy failed (the find still saves, just without a photo). */
export async function savePhoto(tripId: number, findId: number, tempUri: string): Promise<string | null> {
  try {
    const dir = photosDir(tripId)
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
    const filename = `${findId}.jpg`
    const dest = new File(dir, filename)
    if (dest.exists) dest.delete()
    new File(tempUri).copy(dest)
    return filename
  } catch {
    return null
  }
}

/** Absolute URI for a stored find photo, rebuilt from the relative filename so it
 *  survives app-container path changes (we never store the absolute path). */
export function photoUri(tripId: number, filename: string): string {
  return new File(photosDir(tripId), filename).uri
}

/** Remove every find + photo for a trip. Called when the trip itself is deleted
 *  so its logged data doesn't linger as orphans. Best-effort. */
export function deleteFindsForTrip(tripId: number): void {
  for (const f of [findsFile(tripId), findsBackup(tripId)]) {
    try {
      if (f.exists) f.delete()
    } catch {
      // best-effort cleanup
    }
  }
  try {
    const dir = photosDir(tripId)
    if (dir.exists) dir.delete()
  } catch {
    // best-effort cleanup
  }
}

// The `.pcfinds` bundle format the desktop imports — the mirror of the trip
// `.pcbundle`: a zip holding finds.json (manifest) + photos/<filename>. Kept in
// lockstep with the backend importer (FINDS_BUNDLE_FORMAT in api/trips.py).
const FINDS_BUNDLE_FORMAT = 'prospectors-compass.finds-bundle'

/** Build a `.pcfinds` bundle for one trip's finds (notes + GPS + photos) and write
 *  it to the cache, returning the file URI to hand to the share sheet (AirDrop).
 *  Returns null if the trip has no finds yet. Photos that can't be read are skipped
 *  (the find still travels, just without its picture). */
export async function buildFindsBundle(tripId: number, tripName: string): Promise<string | null> {
  const finds = await loadFinds(tripId)
  if (finds.length === 0) return null

  const files: Record<string, Uint8Array> = {}
  for (const f of finds) {
    if (!f.photo) continue
    try {
      const pf = new File(photosDir(tripId), f.photo)
      if (pf.exists) files[`photos/${f.photo}`] = pf.bytesSync()
    } catch {
      // unreadable photo — keep the find, drop the picture
    }
  }
  const manifest = {
    format: FINDS_BUNDLE_FORMAT,
    version: 1,
    exported_at: new Date().toISOString(),
    trip: { id: tripId, name: tripName },
    finds: finds.map((f) => ({
      id: f.id,
      lon: f.lon,
      lat: f.lat,
      kind: f.kind,
      note: f.note,
      created_at: f.created_at,
      photo: f.photo ?? null,
    })),
  }
  files['finds.json'] = strToU8(JSON.stringify(manifest))

  const slug = (tripName || 'trip').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || `trip-${tripId}`
  const out = new File(Paths.cache, `${slug}.pcfinds`)
  out.create({ overwrite: true })
  out.write(zipSync(files))
  return out.uri
}

/** Finds → a Point FeatureCollection for the map markers. */
export function findsFC(finds: Find[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: finds
      .filter((f) => typeof f.lon === 'number' && typeof f.lat === 'number')
      .map((f) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
        properties: { id: f.id, kind: f.kind, note: f.note },
      })),
  }
}
