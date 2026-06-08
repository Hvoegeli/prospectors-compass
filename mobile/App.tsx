import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Camera, Map, UserLocation } from '@maplibre/maplibre-react-native'
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

export default function App() {
  const [status, setStatus] = useState<'loading' | 'granted' | 'denied'>('loading')
  const [fix, setFix] = useState<Fix | null>(null)
  const subRef = useRef<Location.LocationSubscription | null>(null)

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

  const center: [number, number] = fix ? [fix.lon, fix.lat] : FALLBACK_CENTER
  const zoom = fix ? FOLLOW_ZOOM : FALLBACK_ZOOM

  return (
    <View style={styles.root}>
      <Map style={styles.map} mapStyle={DEMO_STYLE}>
        <Camera center={center} zoom={zoom} />
        <UserLocation />
      </Map>
      <View style={styles.hud} pointerEvents="none">
        <Text style={styles.hudTitle}>Prospector&apos;s Compass — Field</Text>
        {status === 'loading' && <Text style={styles.hudText}>Requesting location permission…</Text>}
        {status === 'denied' && (
          <Text style={styles.hudText}>
            Location permission denied — enable it in Settings to see your position.
          </Text>
        )}
        {status === 'granted' && !fix && <Text style={styles.hudText}>Acquiring GPS fix…</Text>}
        {fix && (
          <Text style={styles.hudText}>
            {fix.lat.toFixed(5)}, {fix.lon.toFixed(5)}
            {fix.accuracy != null ? `  ±${Math.round(fix.accuracy)} m` : ''}
          </Text>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  map: { flex: 1 },
  hud: {
    position: 'absolute',
    top: 60,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(14,23,38,0.85)',
    borderRadius: 12,
    padding: 12,
  },
  hudTitle: { color: '#ffffff', fontWeight: '700', fontSize: 14, marginBottom: 4 },
  hudText: { color: '#cbd5e1', fontSize: 13 },
})
