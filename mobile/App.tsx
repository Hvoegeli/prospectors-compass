import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  Map,
  RasterSource,
  type StyleSpecification,
  UserLocation,
} from '@maplibre/maplibre-react-native'
import * as Location from 'expo-location'
import {
  loadTripBundle,
  scoredCellsFC,
  waypointsFC,
  type LoadedTrip,
  type ScoredCell,
  type Waypoint,
} from './src/bundle'

// Colorado I-70 corridor — a sane pre-trip fallback if we somehow render the map
// before a footprint is known (we normally gate on the trip loading first).
const FALLBACK_CENTER: [number, number] = [-106.4, 39.3]
const FOLLOW_ZOOM = 14

// GPS power policy (battery-conservative defaults, per the field spec). While
// idle we track at a coarse accuracy on a slow cadence so the GPS chip can sleep
// between fixes — that duty-cycling, not switching positioning tech, is what
// actually saves power in the backcountry (the lower tiers' wifi/cell assist is
// moot with no signal, so they fall back to GPS anyway). When precision matters
// (center-on-me, and later logging a find) we pull ONE fresh high-accuracy fix.
const IDLE_ACCURACY = Location.Accuracy.Balanced
const IDLE_DISTANCE_M = 25
const IDLE_INTERVAL_MS = 20_000
const PRECISE_ACCURACY = Location.Accuracy.High

// Canonical land-status disclaimer, mirrored verbatim from the backend
// (api/land_status.py). Per CLAUDE.md, any surface that shows land status MUST
// carry it unchanged — a scored cell's gates include ownership/claim status, so
// the rationale card always renders it. Do not edit or soften this text.
const LAND_STATUS_DISCLAIMER =
  'Informational only — not a legal determination of ownership, access, or the ' +
  'right to prospect or collect. Boundaries are approximate and may be out of ' +
  'date. Always verify on the ground and get landowner or agency permission ' +
  'before entering or digging.'

// Turn an engine key like "active_claims" into a readable "Active claims".
function humanize(name: string): string {
  const s = name.replace(/_/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

// Offline base style: no remote fetch (we're offline-first). The dark background
// shows through anywhere the bundled hillshade has no tiles. The real basemap is
// added as an mbtiles:// RasterSource child once the trip's tiles are on disk.
const OFFLINE_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0e1726' } }],
}

type Fix = { lon: number; lat: number; accuracy: number | null }
type Panel = 'trip' | 'layers' | null
// Which overlays are drawn — driven by the Layers panel toggles.
type LayerVis = { basemap: boolean; scored: boolean; waypoints: boolean }

export default function App() {
  const [status, setStatus] = useState<'loading' | 'granted' | 'denied'>('loading')
  const [fix, setFix] = useState<Fix | null>(null)
  const [panel, setPanel] = useState<Panel>(null)

  // The loaded offline trip bundle (basemap + scored areas + waypoints).
  const [trip, setTrip] = useState<LoadedTrip | null>(null)
  const [tripError, setTripError] = useState<string | null>(null)
  const [vis, setVis] = useState<LayerVis>({ basemap: true, scored: true, waypoints: true })

  // Index (into manifest.scored_areas.cells) of the scored cell the user tapped,
  // or null. We key off the index rather than the tapped feature's properties
  // because the rich factors/gates objects don't survive the native press
  // round-trip — only the plain `idx` integer does — so we re-look-up the full
  // cell in memory to render its rationale.
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)

  const subRef = useRef<Location.LocationSubscription | null>(null)
  const cameraRef = useRef<CameraRef>(null)
  const didFit = useRef(false)

  // Load the offline trip bundle once on mount (unzips it into the documents dir
  // on first launch, then just reads it back). This is the keystone — until it
  // lands the map has nothing offline to show.
  useEffect(() => {
    let active = true
    loadTripBundle()
      .then((loaded) => {
        if (active) setTrip(loaded)
      })
      .catch((err) => {
        console.error('trip bundle load failed', err)
        if (active) setTripError(String(err?.message ?? err))
      })
    return () => {
      active = false
    }
  }, [])

  // Request foreground location, then watch position. GPS works with no cell
  // signal (the receiver is passive), so this functions fully in the field.
  useEffect(() => {
    let active = true
    ;(async () => {
      const { status: perm } = await Location.requestForegroundPermissionsAsync()
      if (!active) return
      if (perm !== 'granted') {
        setStatus('denied')
        return
      }
      setStatus('granted')
      // One-shot fix first: watchPositionAsync's first event can lag (it waits
      // for movement — badly so on a static simulator location).
      try {
        const first = await Location.getCurrentPositionAsync({ accuracy: PRECISE_ACCURACY })
        if (active) {
          setFix({ lon: first.coords.longitude, lat: first.coords.latitude, accuracy: first.coords.accuracy })
        }
      } catch {
        // No immediate fix — the watcher below will deliver one when it can.
      }
      if (!active) return
      // Idle tracking is intentionally coarse and slow (battery): the dot stays
      // roughly current, and center-on-me grabs a precise fix on demand.
      const sub = await Location.watchPositionAsync(
        { accuracy: IDLE_ACCURACY, distanceInterval: IDLE_DISTANCE_M, timeInterval: IDLE_INTERVAL_MS },
        (loc) => {
          if (!active) return
          setFix({ lon: loc.coords.longitude, lat: loc.coords.latitude, accuracy: loc.coords.accuracy })
        },
      )
      if (!active) {
        sub.remove()
        return
      }
      subRef.current = sub
    })()
    return () => {
      active = false
      subRef.current?.remove()
    }
  }, [])

  // Derive the map overlays from the manifest once (not on every render).
  const cellsFC = useMemo(() => (trip ? scoredCellsFC(trip.manifest) : null), [trip])
  const wpsFC = useMemo(() => (trip ? waypointsFC(trip.manifest) : null), [trip])

  // The full tapped cell (with its factors/gates), looked up by index in memory.
  const selectedCell = useMemo<ScoredCell | null>(() => {
    if (selectedIdx == null || !trip) return null
    return trip.manifest.scored_areas.cells[selectedIdx] ?? null
  }, [selectedIdx, trip])
  const footprintCenter = useMemo<[number, number]>(() => {
    if (!trip) return FALLBACK_CENTER
    const [minLon, minLat, maxLon, maxLat] = trip.manifest.footprint.bbox
    return [(minLon + maxLon) / 2, (minLat + maxLat) / 2]
  }, [trip])

  // Frame the trip footprint when both the trip and the camera are ready. The
  // camera throws if the map view isn't initialized yet, so swallow and retry on
  // the next tick — the flag is burned only on a successful fit.
  useEffect(() => {
    if (!trip || didFit.current) return
    let tries = 0
    const attempt = () => {
      const cam = cameraRef.current
      if (cam) {
        try {
          cam.fitBounds(trip.manifest.footprint.bbox)
          didFit.current = true
          return
        } catch {
          // map not ready yet — fall through to retry
        }
      }
      if (tries++ < 10) timer = setTimeout(attempt, 200)
    }
    let timer = setTimeout(attempt, 200)
    return () => clearTimeout(timer)
  }, [trip])

  function easeToFix(f: Fix, duration: number): boolean {
    const cam = cameraRef.current
    if (!cam) return false
    try {
      cam.easeTo({ center: [f.lon, f.lat], zoom: FOLLOW_ZOOM, duration })
      return true
    } catch {
      return false
    }
  }

  // Idle tracking is coarse to save battery, so when the user explicitly asks to
  // center we spend one fresh high-accuracy fix to land precisely on them.
  async function centerOnMe(): Promise<void> {
    let target = fix
    try {
      const p = await Location.getCurrentPositionAsync({ accuracy: PRECISE_ACCURACY })
      target = { lon: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy }
      setFix(target)
    } catch {
      // No fresh fix right now — fall back to the last known position.
    }
    if (target) easeToFix(target, 500)
  }

  // A tap on the scored heat surface: pull the cell's index off the pressed
  // feature and open its rationale. Close any open trip/layers panel so the two
  // bottom cards never fight for the same space.
  function onScoredPress(e: { nativeEvent?: { features?: GeoJSON.Feature[] } }): void {
    // Coerce defensively: the native bridge normally preserves `idx` as a number,
    // but accept a stringified one too so the tap never silently no-ops.
    const raw = e.nativeEvent?.features?.[0]?.properties?.idx
    const idx = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw
    if (typeof idx === 'number' && Number.isInteger(idx)) {
      setSelectedIdx(idx)
      setPanel(null)
    }
  }

  function jumpToWaypoint(w: Waypoint): void {
    const cam = cameraRef.current
    if (!cam) return
    try {
      cam.easeTo({ center: [w.lon, w.lat], zoom: FOLLOW_ZOOM, duration: 600 })
      setPanel(null)
    } catch {
      // ignore if the map isn't ready
    }
  }

  function toggleVis(key: keyof LayerVis): void {
    setVis((v) => ({ ...v, [key]: !v[key] }))
  }

  // --- Loading / error gates: don't mount the map until we have a footprint ---
  if (tripError) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerTitle}>Couldn&apos;t open trip</Text>
        <Text style={styles.centerText}>{tripError}</Text>
      </View>
    )
  }
  if (!trip || !cellsFC || !wpsFC) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#cbd5e1" />
        <Text style={styles.centerText}>Loading trip…</Text>
      </View>
    )
  }

  const { manifest, basemapMbtilesUrl } = trip
  const bm = manifest.basemap

  return (
    <View style={styles.root}>
      <Map style={styles.map} mapStyle={OFFLINE_STYLE}>
        <Camera ref={cameraRef} initialViewState={{ center: footprintCenter, zoom: 11.5 }} />

        {/* Offline shaded-relief basemap, read straight from the bundled MBTiles. */}
        {basemapMbtilesUrl && (
          <RasterSource
            id="basemap"
            tiles={[basemapMbtilesUrl]}
            tileSize={bm?.tile_size ?? 256}
            minzoom={bm?.minzoom ?? 0}
            maxzoom={bm?.maxzoom ?? 22}
          >
            <Layer
              id="basemap-layer"
              type="raster"
              layout={{ visibility: vis.basemap ? 'visible' : 'none' }}
            />
          </RasterSource>
        )}

        {/* Engine scored cells — warmer = higher score (matches the desktop heat
            surface). Tap a cell to see its factor-by-factor rationale. */}
        <GeoJSONSource id="scored" data={cellsFC} onPress={onScoredPress}>
          <Layer
            id="scored-fill"
            type="fill"
            layout={{ visibility: vis.scored ? 'visible' : 'none' }}
            paint={{
              'fill-color': [
                'interpolate', ['linear'], ['get', 'score'],
                0, '#fde68a', 50, '#f59e0b', 100, '#b45309',
              ],
              'fill-opacity': 0.45,
              'fill-outline-color': '#92400e',
            }}
          />
          {/* Bright outline on the tapped cell so you can see which one the
              rationale card describes. Matches nothing when idx is -1 (none selected). */}
          <Layer
            id="scored-selected"
            type="line"
            filter={['==', ['get', 'idx'], selectedIdx ?? -1]}
            layout={{ visibility: vis.scored ? 'visible' : 'none' }}
            paint={{ 'line-color': '#f8fafc', 'line-width': 2.5 }}
          />
        </GeoJSONSource>

        {/* Saved waypoints. Circles only — the offline map has no font glyphs, so
            no text labels (same constraint we hit on the desktop contours). */}
        <GeoJSONSource id="waypoints" data={wpsFC}>
          <Layer
            id="wp-circles"
            type="circle"
            layout={{ visibility: vis.waypoints ? 'visible' : 'none' }}
            paint={{
              'circle-radius': 6,
              'circle-color': '#db2777',
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            }}
          />
        </GeoJSONSource>

        <UserLocation />
      </Map>

      {/* Top-left: the trip you're working on */}
      <TouchableOpacity
        style={[styles.fab, styles.topLeft]}
        onPress={() => {
          setSelectedIdx(null)
          setPanel((p) => (p === 'trip' ? null : 'trip'))
        }}
        accessibilityLabel="View current trip"
      >
        <Text style={styles.fabIcon}>📋</Text>
      </TouchableOpacity>

      {/* Top-right: which overlays are shown */}
      <TouchableOpacity
        style={[styles.fab, styles.topRight]}
        onPress={() => {
          setSelectedIdx(null)
          setPanel((p) => (p === 'layers' ? null : 'layers'))
        }}
        accessibilityLabel="Map layers"
      >
        <Text style={styles.fabIcon}>🗂️</Text>
      </TouchableOpacity>

      {/* Bottom-right: recenter on the user's GPS position */}
      <TouchableOpacity
        style={[styles.fab, styles.bottomRight, !fix && styles.fabDisabled]}
        onPress={centerOnMe}
        disabled={!fix}
        accessibilityLabel="Center map on my location"
      >
        <Text style={styles.fabIcon}>📍</Text>
      </TouchableOpacity>

      {/* Bottom-left: frame the whole trip footprint */}
      <TouchableOpacity
        style={[styles.fab, styles.bottomLeft]}
        onPress={() => {
          didFit.current = false
          const cam = cameraRef.current
          if (cam) {
            try {
              cam.fitBounds(manifest.footprint.bbox)
              didFit.current = true
            } catch {
              // ignore if not ready
            }
          }
        }}
        accessibilityLabel="Frame the whole trip"
      >
        <Text style={styles.fabIcon}>🗺️</Text>
      </TouchableOpacity>

      {/* Top-center status pill: app name + live GPS readout */}
      <View style={styles.pill} pointerEvents="none">
        <Text style={styles.pillTitle}>Prospector&apos;s Compass</Text>
        {status === 'loading' && <Text style={styles.pillText}>Requesting location…</Text>}
        {status === 'denied' && <Text style={styles.pillText}>Location off — enable in Settings</Text>}
        {status === 'granted' && !fix && <Text style={styles.pillText}>Acquiring GPS…</Text>}
        {fix && (
          <Text style={styles.pillText}>
            {fix.lat.toFixed(5)}, {fix.lon.toFixed(5)}
            {fix.accuracy != null ? `  ±${Math.round(fix.accuracy)} m` : ''}
          </Text>
        )}
      </View>

      {/* Slide-in panel for Trip / Layers, populated from the loaded bundle. */}
      {panel && (
        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>{panel === 'trip' ? manifest.trip.name : 'Map layers'}</Text>
            <TouchableOpacity onPress={() => setPanel(null)} accessibilityLabel="Close">
              <Text style={styles.panelClose}>✕</Text>
            </TouchableOpacity>
          </View>

          {panel === 'trip' ? (
            <View>
              <Text style={styles.panelMeta}>
                Looking for {manifest.scored_areas.target} · {manifest.trip.waypoints.length} spot
                {manifest.trip.waypoints.length === 1 ? '' : 's'} · {manifest.scored_areas.count} scored cells
              </Text>
              <ScrollView style={styles.wpList}>
                {manifest.trip.waypoints.length === 0 && (
                  <Text style={styles.panelBody}>No saved spots in this trip yet.</Text>
                )}
                {manifest.trip.waypoints.map((w) => (
                  <TouchableOpacity key={w.id} style={styles.wpRow} onPress={() => jumpToWaypoint(w)}>
                    <Text style={styles.wpTitle}>{w.title || w.kind || `Spot ${w.id}`}</Text>
                    {!!w.note && <Text style={styles.wpNote} numberOfLines={1}>{w.note}</Text>}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          ) : (
            <View>
              <LayerToggle label="Terrain basemap" on={vis.basemap} disabled={!basemapMbtilesUrl} onPress={() => toggleVis('basemap')} />
              <LayerToggle label="Scored areas" on={vis.scored} onPress={() => toggleVis('scored')} />
              <LayerToggle label="Saved spots" on={vis.waypoints} onPress={() => toggleVis('waypoints')} />
              {!basemapMbtilesUrl && (
                <Text style={styles.panelMeta}>This bundle carried no basemap — only the scored areas and spots are shown.</Text>
              )}
            </View>
          )}
        </View>
      )}

      {/* Rationale card: WHY a tapped cell scored what it did. The factors come
          straight from the engine (deterministic, factor-by-factor), honoring the
          project rule that a recommendation must always show its evidence. */}
      {selectedCell && (
        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>Why this scored {Math.round(selectedCell.score)}</Text>
            <TouchableOpacity onPress={() => setSelectedIdx(null)} accessibilityLabel="Close">
              <Text style={styles.panelClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.panelMeta}>
            {selectedCell.band ? `${humanize(selectedCell.band)} confidence · ` : ''}
            looking for {manifest.scored_areas.target}
          </Text>
          {(selectedCell.factors ?? []).length > 0 && (
            <Text style={styles.rationaleSub}>Each factor adds points, then access gates multiply.</Text>
          )}
          <ScrollView style={styles.wpList}>
            {[...(selectedCell.factors ?? [])]
              .sort((a, b) => b.contribution - a.contribution)
              .map((f) => {
                const pts = Math.round(f.contribution * 100)
                return (
                  <View key={f.name} style={styles.factorRow}>
                    <View style={styles.factorHead}>
                      <Text style={styles.factorLabel}>{f.label}</Text>
                      <Text style={styles.factorPts}>{pts > 0 ? `+${pts}` : '0'} pts</Text>
                    </View>
                    <Text style={styles.factorRaw}>{f.raw}</Text>
                  </View>
                )
              })}
            {(selectedCell.factors ?? []).length === 0 && (
              <Text style={styles.panelBody}>No factor breakdown recorded for this cell.</Text>
            )}

            {(selectedCell.gates ?? []).length > 0 && (
              <View>
                <Text style={styles.gateHeading}>Land status</Text>
                {(selectedCell.gates ?? []).map((g) => (
                  <View key={g.name} style={styles.factorRow}>
                    <View style={styles.factorHead}>
                      <Text style={styles.factorLabel}>{humanize(g.name)}</Text>
                      <Text style={[styles.gateState, g.gate >= 1 ? styles.gateOpen : styles.gateRestricted]}>
                        ×{g.gate}
                      </Text>
                    </View>
                    <Text style={styles.factorRaw}>{g.raw}</Text>
                  </View>
                ))}
                <Text style={styles.landDisc}>{LAND_STATUS_DISCLAIMER}</Text>
              </View>
            )}
          </ScrollView>
        </View>
      )}
    </View>
  )
}

function LayerToggle({
  label,
  on,
  onPress,
  disabled,
}: {
  label: string
  on: boolean
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <TouchableOpacity
      style={[styles.toggleRow, disabled && styles.fabDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.toggleLabel}>{label}</Text>
      <Text style={[styles.toggleState, on && styles.toggleStateOn]}>{on ? 'On' : 'Off'}</Text>
    </TouchableOpacity>
  )
}

const FAB = 52
const styles = StyleSheet.create({
  root: { flex: 1 },
  map: { flex: 1 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0e1726', padding: 24 },
  centerTitle: { color: '#ffffff', fontWeight: '700', fontSize: 18, marginBottom: 8 },
  centerText: { color: '#cbd5e1', fontSize: 14, textAlign: 'center', marginTop: 8 },

  fab: {
    position: 'absolute',
    width: FAB,
    height: FAB,
    borderRadius: FAB / 2,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  fabDisabled: { opacity: 0.5 },
  fabIcon: { fontSize: 22 },
  topLeft: { top: 60, left: 16 },
  topRight: { top: 60, right: 16 },
  bottomRight: { bottom: 48, right: 16 },
  bottomLeft: { bottom: 48, left: 16 },

  pill: {
    position: 'absolute',
    top: 64,
    alignSelf: 'center',
    maxWidth: 220,
    backgroundColor: 'rgba(14,23,38,0.85)',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  pillTitle: { color: '#ffffff', fontWeight: '700', fontSize: 13, textAlign: 'center' },
  pillText: { color: '#cbd5e1', fontSize: 12, textAlign: 'center', marginTop: 2 },

  panel: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 116,
    maxHeight: 360,
    backgroundColor: 'rgba(14,23,38,0.96)',
    borderRadius: 16,
    padding: 18,
  },
  panelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  panelTitle: { color: '#ffffff', fontWeight: '700', fontSize: 16, flexShrink: 1, paddingRight: 8 },
  panelClose: { color: '#cbd5e1', fontSize: 18, paddingHorizontal: 6 },
  panelBody: { color: '#cbd5e1', fontSize: 14, lineHeight: 20 },
  panelMeta: { color: '#94a3b8', fontSize: 12, marginBottom: 10, lineHeight: 17 },

  wpList: { maxHeight: 250 },
  wpRow: { paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(148,163,184,0.25)' },
  wpTitle: { color: '#e2e8f0', fontSize: 15, fontWeight: '600' },
  wpNote: { color: '#94a3b8', fontSize: 12, marginTop: 2 },

  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(148,163,184,0.25)',
  },
  toggleLabel: { color: '#e2e8f0', fontSize: 15 },
  toggleState: { color: '#64748b', fontSize: 14, fontWeight: '700' },
  toggleStateOn: { color: '#34d399' },

  rationaleSub: { color: '#cbd5e1', fontSize: 12, marginBottom: 4, lineHeight: 16 },
  factorRow: { paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(148,163,184,0.25)' },
  factorHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  factorLabel: { color: '#e2e8f0', fontSize: 14, fontWeight: '600', flexShrink: 1, paddingRight: 8 },
  factorPts: { color: '#fbbf24', fontSize: 13, fontWeight: '700' },
  factorRaw: { color: '#94a3b8', fontSize: 12, marginTop: 2, lineHeight: 16 },

  gateHeading: { color: '#cbd5e1', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14 },
  gateState: { fontSize: 13, fontWeight: '700' },
  gateOpen: { color: '#34d399' },
  gateRestricted: { color: '#f87171' },
  landDisc: { color: '#94a3b8', fontSize: 11, fontStyle: 'italic', lineHeight: 15, marginTop: 10 },
})
