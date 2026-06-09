import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Camera, type CameraRef, Map, UserLocation } from '@maplibre/maplibre-react-native'
import * as Location from 'expo-location'

// First-milestone basemap: MapLibre's public demo style (ONLINE). Its only job is
// to prove the native map renders and GPS works on the device. The offline MBTiles
// trip bundle replaces this in the next milestone — offline-first is the point.
const DEMO_STYLE = 'https://demotiles.maplibre.org/style.json'

// Colorado I-70 corridor — the desktop's default view; shown until we get a fix.
const FALLBACK_CENTER: [number, number] = [-106.4, 39.3]
const FALLBACK_ZOOM = 6.5
const FOLLOW_ZOOM = 14

type Fix = { lon: number; lat: number; accuracy: number | null }
type Panel = 'trip' | 'layers' | null

export default function App() {
  const [status, setStatus] = useState<'loading' | 'granted' | 'denied'>('loading')
  const [fix, setFix] = useState<Fix | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const subRef = useRef<Location.LocationSubscription | null>(null)
  const cameraRef = useRef<CameraRef>(null)
  // Center on the user once, the first time we get a fix. After that the map is
  // the user's to pan/zoom freely — re-centering only happens on the 📍 button.
  const didAutoCenter = useRef(false)

  // Request foreground location permission, then watch position. GPS works with no
  // cell signal (the receiver is passive), so this functions fully in the field.
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
      // One-shot fix first: watchPositionAsync is event-driven and its first
      // event can lag (it waits for movement — badly so on a static simulator
      // location), so request the current position directly for an instant fix.
      try {
        const first = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
        if (active) {
          setFix({ lon: first.coords.longitude, lat: first.coords.latitude, accuracy: first.coords.accuracy })
        }
      } catch {
        // No immediate fix — the watcher below will deliver one when it can.
      }
      if (!active) return
      const sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 5, timeInterval: 2000 },
        (loc) => {
          if (!active) return
          setFix({
            lon: loc.coords.longitude,
            lat: loc.coords.latitude,
            accuracy: loc.coords.accuracy,
          })
        },
      )
      // If we unmounted while watchPositionAsync was still resolving, cleanup
      // already ran (subRef was null) — remove this orphaned watcher now so it
      // doesn't keep the GPS alive and drain the battery.
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

  // Ease the camera to a fix. The native camera throws if the map view isn't
  // initialized yet, so swallow that and report success — the caller decides
  // whether to retry. Returns false if nothing moved (map not ready / no ref).
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

  // First fix: glide the camera to the user once. The flag is burned only on a
  // successful move, so an early fix (before the map is ready) retries on the
  // next fix instead of leaving us stuck off-center. Subsequent fixes are
  // ignored, so it never fights the user's own panning.
  useEffect(() => {
    if (fix && !didAutoCenter.current && easeToFix(fix, 800)) {
      didAutoCenter.current = true
    }
  }, [fix])

  function centerOnMe(): void {
    if (fix) easeToFix(fix, 500)
  }

  return (
    <View style={styles.root}>
      <Map style={styles.map} mapStyle={DEMO_STYLE}>
        {/* initialViewState (not controlled center/zoom) so pinch-zoom + pan stay
            in the user's hands; we move the camera imperatively via the ref. */}
        <Camera
          ref={cameraRef}
          initialViewState={{ center: FALLBACK_CENTER, zoom: FALLBACK_ZOOM }}
        />
        <UserLocation />
      </Map>

      {/* Top-left: the trip you're working on */}
      <TouchableOpacity
        style={[styles.fab, styles.topLeft]}
        onPress={() => setPanel((p) => (p === 'trip' ? null : 'trip'))}
        accessibilityLabel="View current trip"
      >
        <Text style={styles.fabIcon}>📋</Text>
      </TouchableOpacity>

      {/* Top-right: the layers loaded for this trip */}
      <TouchableOpacity
        style={[styles.fab, styles.topRight]}
        onPress={() => setPanel((p) => (p === 'layers' ? null : 'layers'))}
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

      {/* Bottom-left: reserved for a to-be-determined tool */}
      <TouchableOpacity
        style={[styles.fab, styles.bottomLeft]}
        onPress={() => setPanel(null)}
        accessibilityLabel="More (coming soon)"
      >
        <Text style={[styles.fabIcon, styles.fabIconMuted]}>•••</Text>
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

      {/* Slide-in panel for Trip / Layers. Placeholder content until the offline
          .pcbundle loader lands — then these populate from the carried trip. */}
      {panel && (
        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>{panel === 'trip' ? 'Current trip' : 'Map layers'}</Text>
            <TouchableOpacity onPress={() => setPanel(null)} accessibilityLabel="Close">
              <Text style={styles.panelClose}>✕</Text>
            </TouchableOpacity>
          </View>
          {panel === 'trip' ? (
            <Text style={styles.panelBody}>
              No trip loaded yet.{'\n\n'}Export a trip from the desktop app and AirDrop the
              .pcbundle to this phone to carry your saved spots, notes, and the scored map —
              all offline.
            </Text>
          ) : (
            <Text style={styles.panelBody}>
              Layers arrive with your trip bundle: mines, rivers, land status, and the
              engine&apos;s scored spots.{'\n\n'}None are loaded yet — bring a trip over to
              switch them on here.
            </Text>
          )}
        </View>
      )}
    </View>
  )
}

const FAB = 52
const styles = StyleSheet.create({
  root: { flex: 1 },
  map: { flex: 1 },

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
  fabIconMuted: { color: '#64748b', fontSize: 20, fontWeight: '700' },
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
    backgroundColor: 'rgba(14,23,38,0.96)',
    borderRadius: 16,
    padding: 18,
  },
  panelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  panelTitle: { color: '#ffffff', fontWeight: '700', fontSize: 16 },
  panelClose: { color: '#cbd5e1', fontSize: 18, paddingHorizontal: 6 },
  panelBody: { color: '#cbd5e1', fontSize: 14, lineHeight: 20 },
})
