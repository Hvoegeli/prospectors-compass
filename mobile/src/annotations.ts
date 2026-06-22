// Field annotations: edits the user makes ON the phone, on top of the read-only
// trip bundle the desktop shipped. Two kinds, both stored per trip:
//   - notes: free-text the user attaches to ANY pin (a planned spot from the
//            bundle, or a dropped pin), keyed by the waypoint id as a string.
//   - pins:  markers the user long-press-drops at an arbitrary location.
//
// The bundle itself is immutable (it's a snapshot), so these overlays live in
// their own file (`annotations-<tripId>.json`) and are merged at display time.
// Everything is local and crash-safe (backup-first writes, serialized), the same
// discipline as finds — a field edit must never be lost.

import { File, Paths } from 'expo-file-system'

export type DroppedPin = {
  id: number // Date.now() at drop time (matches the find-id convention)
  lon: number
  lat: number
  title: string
  created_at: string // ISO 8601
}

export type Annotations = {
  notes: Record<string, string> // wpId (as string) -> note text
  pins: DroppedPin[]
}

export const EMPTY_ANNOTATIONS: Annotations = { notes: {}, pins: [] }

function annFile(tripId: number): File {
  return new File(Paths.document, `annotations-${tripId}.json`)
}
// Backup written before the main file on every save, so an interrupted write can
// always be recovered from one file or the other (same scheme as finds).
function annBackup(tripId: number): File {
  return new File(Paths.document, `annotations-${tripId}.bak.json`)
}

function parse(f: File): Annotations | null {
  if (!f.exists) return null
  try {
    const p = JSON.parse(f.textSync()) as Partial<Annotations>
    return {
      notes: p.notes && typeof p.notes === 'object' ? p.notes : {},
      pins: Array.isArray(p.pins) ? p.pins : [],
    }
  } catch {
    return null // corrupt/truncated — signal "unreadable" so we try the backup
  }
}

/** This trip's annotations, falling back to the backup if the main file is
 *  missing or corrupt. Empty (no notes, no pins) if none exist yet. */
export async function loadAnnotations(tripId: number): Promise<Annotations> {
  return parse(annFile(tripId)) ?? parse(annBackup(tripId)) ?? { notes: {}, pins: [] }
}

// Serialize all writes for one device so two rapid edits can't read the same base
// state and clobber each other (the second waits for the first, then re-reads).
let writeQueue: Promise<unknown> = Promise.resolve()

function persist(tripId: number, data: Annotations): void {
  const json = JSON.stringify(data)
  // Backup first (complete new state), then the main file — a crash mid-write
  // still leaves one complete copy.
  const bak = annBackup(tripId)
  bak.create({ overwrite: true })
  bak.write(json)
  const main = annFile(tripId)
  main.create({ overwrite: true })
  main.write(json)
}

async function mutate(tripId: number, fn: (a: Annotations) => Annotations): Promise<Annotations> {
  const run = writeQueue.then(async () => {
    const next = fn(await loadAnnotations(tripId))
    persist(tripId, next)
    return next
  })
  writeQueue = run.catch(() => undefined) // keep the chain alive past any error
  return run
}

/** Set (or clear, when blank) the note on a waypoint — planned or dropped. */
export function setNote(tripId: number, wpId: string, note: string): Promise<Annotations> {
  return mutate(tripId, (a) => {
    const notes = { ...a.notes }
    if (note.trim()) notes[wpId] = note
    else delete notes[wpId]
    return { ...a, notes }
  })
}

/** Add a long-press-dropped pin. */
export function addPin(tripId: number, pin: DroppedPin): Promise<Annotations> {
  return mutate(tripId, (a) => ({ ...a, pins: [...a.pins, pin] }))
}

/** Remove a dropped pin and any note attached to it. */
export function deletePin(tripId: number, pinId: number): Promise<Annotations> {
  return mutate(tripId, (a) => {
    const notes = { ...a.notes }
    delete notes[String(pinId)]
    return { notes, pins: a.pins.filter((p) => p.id !== pinId) }
  })
}

/** Dropped pins → a Point FeatureCollection for the map markers. */
export function pinsFC(pins: DroppedPin[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: pins
      .filter((p) => typeof p.lon === 'number' && typeof p.lat === 'number')
      .map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { id: p.id },
      })),
  }
}
