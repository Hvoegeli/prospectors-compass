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

/** All finds logged for this trip, oldest first. Empty if none yet (or unreadable). */
export async function loadFinds(tripId: number): Promise<Find[]> {
  const f = findsFile(tripId)
  if (!f.exists) return []
  try {
    const parsed = JSON.parse(f.textSync()) as unknown
    return Array.isArray(parsed) ? (parsed as Find[]) : []
  } catch {
    // Corrupt file — start fresh rather than crash the field app. (We never
    // delete finds in normal use, so this should only happen after manual
    // tampering or a truncated write.)
    return []
  }
}

/** Append one find (append-only) and return the updated list. */
export async function appendFind(tripId: number, find: Find): Promise<Find[]> {
  const updated = [...(await loadFinds(tripId)), find]
  const f = findsFile(tripId)
  f.create({ overwrite: true })
  f.write(JSON.stringify(updated))
  return updated
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
