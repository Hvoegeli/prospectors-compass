// Field finds: things the user discovers and logs ON the phone, in the field.
//
// A find is a waypoint-shaped record (so it round-trips cleanly into the trip's
// waypoints array on the desktop later — see backend Trip.waypoints) plus a
// `created_at` stamp. Finds are stored append-only in the documents directory,
// in their OWN file keyed by trip id (`finds-<tripId>.json`) so loading a new
// trip bundle can never overwrite finds logged on an earlier trip. Everything is
// local: no network, works with zero signal.

import { File, Paths } from 'expo-file-system'

export type Find = {
  id: number
  lon: number
  lat: number
  kind: string
  note: string
  created_at: string // ISO 8601
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
