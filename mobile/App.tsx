import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  Map,
  type MapRef,
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
} from './src/bundle'
import { appendFind, findsFC, loadFinds, photoUri, savePhoto, type Find } from './src/finds'

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
// Cap on-demand precise fixes: getCurrentPositionAsync has no timeout of its own
// and can stall for a long time under poor sky view (canyon/canopy) — exactly
// the field condition this app runs in. After this we fall back to the last fix.
const GPS_FIX_TIMEOUT_MS = 8_000

// Canonical land-status disclaimer, mirrored verbatim from the backend
// (api/land_status.py). Per CLAUDE.md, any surface that shows land status MUST
// carry it unchanged — a scored cell's gates include ownership/claim status, so
// the rationale card always renders it. Do not edit or soften this text.
const LAND_STATUS_DISCLAIMER =
  'Informational only — not a legal determination of ownership, access, or the ' +
  'right to prospect or collect. Boundaries are approximate and may be out of ' +
  'date. Always verify on the ground and get landowner or agency permission ' +
  'before entering or digging.'

// Resolve a promise but give up after `ms`, yielding null instead of hanging.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([
    p.then((v) => {
      clearTimeout(timer)
      return v
    }),
    timeout,
  ])
}

// Turn an engine key like "active_claims" into a readable "Active claims".
function humanize(name: string): string {
  const s = name.replace(/_/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

// Compact local timestamp for a logged find, e.g. "Jun 14, 3:05pm". Built by hand
// (not toLocaleString) so it doesn't depend on Hermes Intl being present.
function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  let h = d.getHours()
  const ampm = h >= 12 ? 'pm' : 'am'
  h = h % 12
  if (h === 0) h = 12
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${mo} ${d.getDate()}, ${h}:${min}${ampm}`
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
type Panel = 'trip' | 'layers' | 'logFind' | null
// Which overlays are drawn — driven by the Layers panel toggles.
type LayerVis = { basemap: boolean; scored: boolean; waypoints: boolean; finds: boolean }

// Quick-pick kinds for logging a field find (stored as the kind string).
const FIND_KINDS = ['Gold', 'Float', 'Outcrop', 'Other'] as const
// Emerald find markers — deliberately distinct from the magenta planned waypoints.
const FIND_COLOR = '#34d399'

export default function App() {
  const [status, setStatus] = useState<'loading' | 'granted' | 'denied'>('loading')
  const [fix, setFix] = useState<Fix | null>(null)
  const [panel, setPanel] = useState<Panel>(null)

  // The loaded offline trip bundle (basemap + scored areas + waypoints).
  const [trip, setTrip] = useState<LoadedTrip | null>(null)
  const [tripError, setTripError] = useState<string | null>(null)
  const [vis, setVis] = useState<LayerVis>({ basemap: true, scored: true, waypoints: true, finds: true })

  // Field finds logged on this phone (append-only, persisted locally per trip),
  // plus the in-progress log-a-find form state.
  const [finds, setFinds] = useState<Find[]>([])
  const [findKind, setFindKind] = useState<string>(FIND_KINDS[0])
  const [findNote, setFindNote] = useState('')
  const [savingFind, setSavingFind] = useState(false)
  // Temp URI of a photo picked for the in-progress find (copied to permanent
  // storage only on Save), and the URI currently shown in the full-screen viewer.
  const [pendingPhotoUri, setPendingPhotoUri] = useState<string | null>(null)
  const [viewerUri, setViewerUri] = useState<string | null>(null)
  // Keyboard height, so the bottom find-form panel can lift above the keyboard
  // (otherwise it covers the note field and the Save button).
  const [kbHeight, setKbHeight] = useState(0)

  // Index (into manifest.scored_areas.cells) of the scored cell the user tapped,
  // or null. We key off the index rather than the tapped feature's properties
  // because the rich factors/gates objects don't survive the native press
  // round-trip — only the plain `idx` integer does — so we re-look-up the full
  // cell in memory to render its rationale.
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)

  const subRef = useRef<Location.LocationSubscription | null>(null)
  const cameraRef = useRef<CameraRef>(null)
  const mapRef = useRef<MapRef>(null)
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

  // Track keyboard height so the find-form panel can lift above it.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', (e) => setKbHeight(e.endCoordinates.height))
    const hide = Keyboard.addListener('keyboardWillHide', () => setKbHeight(0))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  // Load this trip's previously-logged finds once the trip (and its id) is known.
  useEffect(() => {
    if (!trip) return
    let active = true
    loadFinds(trip.manifest.trip.id)
      .then((loaded) => {
        if (active) setFinds(loaded)
      })
      .catch(() => {
        // No finds yet (or unreadable) — leave the list empty.
      })
    return () => {
      active = false
    }
  }, [trip])

  // Derive the map overlays from the manifest once (not on every render).
  const cellsFC = useMemo(() => (trip ? scoredCellsFC(trip.manifest) : null), [trip])
  const wpsFC = useMemo(() => (trip ? waypointsFC(trip.manifest) : null), [trip])
  const findsFCData = useMemo(() => findsFC(finds), [finds])

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

  // Frame the whole trip footprint. Returns false if the camera/trip isn't ready
  // yet (the camera throws before the map view initializes). Shared by the
  // auto-frame effect below and the Overview bar button.
  function fitFootprint(): boolean {
    const cam = cameraRef.current
    if (!cam || !trip) return false
    try {
      cam.fitBounds(trip.manifest.footprint.bbox)
      didFit.current = true
      return true
    } catch {
      return false
    }
  }

  // Frame the footprint once when the trip and camera are ready, retrying on the
  // next tick until it lands (the flag is burned only on a successful fit).
  useEffect(() => {
    if (!trip || didFit.current) return
    let tries = 0
    const attempt = () => {
      if (fitFootprint()) return
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

  // One fresh high-accuracy fix on demand (idle tracking is coarse to save
  // battery). Updates the live fix and returns it, or null if none is available.
  async function getPreciseFix(): Promise<Fix | null> {
    try {
      const p = await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: PRECISE_ACCURACY }),
        GPS_FIX_TIMEOUT_MS,
      )
      if (!p) return null // timed out — caller falls back to the last known fix
      const f: Fix = { lon: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy }
      setFix(f)
      return f
    } catch {
      return null
    }
  }

  // When the user explicitly asks to center, spend one precise fix to land on them.
  async function centerOnMe(): Promise<void> {
    const target = (await getPreciseFix()) ?? fix
    if (target) easeToFix(target, 500)
  }

  // Log a find at the user's current position: grab a fresh precise fix so the
  // pin is accurate despite coarse idle tracking, append it to this trip's local
  // append-only log, and drop the form.
  async function saveFind(): Promise<void> {
    if (!trip || savingFind) return
    setSavingFind(true)
    try {
      const at = (await getPreciseFix()) ?? fix
      if (!at) return // no position — Save is disabled in this case, belt-and-suspenders
      const id = Date.now()
      const tripId = trip.manifest.trip.id
      // Copy the photo into permanent storage BEFORE writing the find, so a saved
      // find never points at a missing image. A photo is optional: if the copy
      // fails, save the find anyway and just tell the user.
      let photo: string | undefined
      if (pendingPhotoUri) {
        const saved = await savePhoto(tripId, id, pendingPhotoUri)
        if (saved) photo = saved
        else Alert.alert('Photo not attached', 'The find was saved, but the photo could not be stored.')
      }
      const find: Find = {
        id,
        lon: at.lon,
        lat: at.lat,
        kind: findKind,
        note: findNote.trim(),
        created_at: new Date().toISOString(),
        ...(photo ? { photo } : {}),
      }
      setFinds(await appendFind(tripId, find))
      setFindNote('')
      setFindKind(FIND_KINDS[0])
      setPendingPhotoUri(null)
      setPanel(null)
    } finally {
      setSavingFind(false)
    }
  }

  // Launch the camera or library, then hold the chosen photo's temp URI for the
  // form preview (it's copied into permanent storage only on Save).
  async function pickPhoto(source: 'camera' | 'library'): Promise<void> {
    try {
      const perm =
        source === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!perm.granted) {
        Alert.alert(
          source === 'camera' ? 'Camera access is off' : 'Photo access is off',
          'Enable it in Settings to attach photos. You can still log the find without one.',
        )
        return
      }
      const opts: ImagePicker.ImagePickerOptions = { quality: 0.6, mediaTypes: ['images'] }
      const result =
        source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts)
      const uri = result.canceled ? null : (result.assets?.[0]?.uri ?? null)
      if (uri) setPendingPhotoUri(uri)
    } catch {
      Alert.alert('Couldn’t open the camera', 'Try again, or log the find without a photo.')
    }
  }

  // Offer camera vs library before picking.
  function addPhoto(): void {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ['Take photo', 'Choose from library', 'Cancel'], cancelButtonIndex: 2 },
      (i) => {
        if (i === 0) pickPhoto('camera')
        else if (i === 1) pickPhoto('library')
      },
    )
  }

  // Tap anywhere on the map: query the scored-fill layer directly at that pixel.
  // We do NOT use the source's own onPress because that only fires when the
  // scored layer is the topmost feature in a 44px hitbox — so a tap near a
  // waypoint/find marker (which render ABOVE the cells) would be swallowed and
  // the cell wouldn't select. queryRenderedFeatures({layers:['scored-fill']})
  // ignores whatever is stacked on top, so every cell is tappable. Tapping a
  // spot with no cell dismisses any open rationale card.
  async function onMapPress(e: { nativeEvent?: { point?: [number, number] } }): Promise<void> {
    const pt = e.nativeEvent?.point
    if (!pt || !mapRef.current) return
    try {
      const feats = await mapRef.current.queryRenderedFeatures(pt, { layers: ['scored-fill'] })
      const raw = feats?.[0]?.properties?.idx
      const idx = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw
      if (typeof idx === 'number' && Number.isInteger(idx)) {
        setSelectedIdx(idx)
        setPanel(null)
      } else {
        setSelectedIdx(null) // tapped empty space — close any open rationale card
      }
    } catch {
      // query failed (map not ready) — ignore
    }
  }

  // Fly the camera to a point and close the panel. Shared by the waypoint and
  // find lists.
  function flyTo(lon: number, lat: number): void {
    const cam = cameraRef.current
    if (!cam) return
    try {
      cam.easeTo({ center: [lon, lat], zoom: FOLLOW_ZOOM, duration: 600 })
      setPanel(null)
    } catch {
      // ignore if the map isn't ready
    }
  }

  function toggleVis(key: keyof LayerVis): void {
    setVis((v) => ({ ...v, [key]: !v[key] }))
  }

  // Open (or toggle off) a panel. Always clears any open rationale card first so
  // the card and a panel never stack — the single place that enforces that
  // exclusion, instead of repeating it at every bar button.
  function openPanel(p: Exclude<Panel, null>): void {
    setSelectedIdx(null)
    setPendingPhotoUri(null) // discard any unsaved photo when entering/leaving the form
    setPanel((cur) => (cur === p ? null : p))
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
      {/* logo/attribution off: our four corner FABs leave no room for MapLibre's
          default ornaments (they sat UNDER the buttons), and the basemap is
          self-hosted public-domain USGS data, so no third-party attribution is
          owed. Data provenance lives in docs/DATA_SOURCES.md. */}
      <Map ref={mapRef} style={styles.map} mapStyle={OFFLINE_STYLE} logo={false} attribution={false} onPress={onMapPress}>
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

        {/* Engine scored cells, painted with the SAME "Magma" heat ramp as the
            desktop (frontend recommendColor): bright/pale = higher score, dark
            purple = low. Floors at score 15 (the engine min_score), opacity 0.6.
            Mirrored here verbatim so both surfaces read identically. Taps are
            handled at the Map level (onMapPress) so markers on top can't swallow
            them. */}
        <GeoJSONSource id="scored" data={cellsFC}>
          <Layer
            id="scored-fill"
            type="fill"
            layout={{ visibility: vis.scored ? 'visible' : 'none' }}
            paint={{
              'fill-color': [
                'interpolate', ['linear'], ['get', 'score'],
                15, '#3b0f70', 35, '#8c2981', 55, '#de4968', 75, '#fe9f6d', 100, '#fcfdbf',
              ],
              'fill-opacity': 0.6,
              'fill-outline-color': 'rgba(15,23,42,0.25)',
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

        {/* Field finds logged on this phone — emerald, deliberately distinct from
            the magenta planned waypoints, with a dark ring so they read on the
            bright Magma cells too. */}
        <GeoJSONSource id="finds" data={findsFCData}>
          <Layer
            id="find-circles"
            type="circle"
            layout={{ visibility: vis.finds ? 'visible' : 'none' }}
            paint={{
              'circle-radius': 7,
              'circle-color': FIND_COLOR,
              'circle-stroke-color': '#06281e',
              'circle-stroke-width': 2,
            }}
          />
        </GeoJSONSource>

        <UserLocation />
      </Map>

      {/* Bottom control bar — every action in one row. The emerald Log-find
          (primary field-capture action) sits dead center, per the layout. */}
      <View style={styles.bottomBar}>
        <BarButton icon="📋" label="Trip" active={panel === 'trip'} onPress={() => openPanel('trip')} />
        <BarButton icon="🗂️" label="Layers" active={panel === 'layers'} onPress={() => openPanel('layers')} />
        <BarButton
          icon="＋"
          label="Log find"
          primary
          active={panel === 'logFind'}
          disabled={!fix}
          onPress={() => openPanel('logFind')}
        />
        <BarButton icon="📍" label="Center" disabled={!fix} onPress={centerOnMe} />
        <BarButton icon="🗺️" label="Overview" onPress={fitFootprint} />
      </View>

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

      {/* Slide-in panel for Trip / Layers / Log-a-find, populated from the bundle.
          In the find form, lift above the keyboard so the note + Save stay visible. */}
      {panel && (
        <View style={[styles.panel, panel === 'logFind' && kbHeight > 0 && { bottom: kbHeight + 12 }]}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>
              {panel === 'trip' ? manifest.trip.name : panel === 'layers' ? 'Map layers' : 'Log a find'}
            </Text>
            <TouchableOpacity
              onPress={() => {
                setPendingPhotoUri(null)
                setPanel(null)
              }}
              accessibilityLabel="Close"
            >
              <Text style={styles.panelClose}>✕</Text>
            </TouchableOpacity>
          </View>

          {panel === 'trip' ? (
            <View>
              <Text style={styles.panelMeta}>
                Looking for {manifest.scored_areas.target} · {manifest.trip.waypoints.length} spot
                {manifest.trip.waypoints.length === 1 ? '' : 's'} · {finds.length} find
                {finds.length === 1 ? '' : 's'}
              </Text>
              <ScrollView style={styles.wpList}>
                <Text style={styles.gateHeading}>Planned spots</Text>
                {manifest.trip.waypoints.length === 0 && (
                  <Text style={styles.panelBody}>No saved spots in this trip yet.</Text>
                )}
                {manifest.trip.waypoints.map((w) => (
                  <TouchableOpacity key={w.id} style={styles.wpRow} onPress={() => flyTo(w.lon, w.lat)}>
                    <Text style={styles.wpTitle}>{w.title || w.kind || `Spot ${w.id}`}</Text>
                    {!!w.note && <Text style={styles.wpNote} numberOfLines={1}>{w.note}</Text>}
                  </TouchableOpacity>
                ))}
                <Text style={styles.gateHeading}>Your finds</Text>
                {finds.length === 0 && (
                  <Text style={styles.panelBody}>No finds yet. Tap ＋ to log one where you stand.</Text>
                )}
                {/* Newest first — the find you just logged is the one you want. */}
                {[...finds].reverse().map((f) => {
                  const thumb = f.photo ? photoUri(manifest.trip.id, f.photo) : null
                  return (
                    <TouchableOpacity key={f.id} style={styles.findRow} onPress={() => flyTo(f.lon, f.lat)}>
                      {thumb ? <PhotoThumb uri={thumb} onPress={() => setViewerUri(thumb)} /> : null}
                      <View style={styles.findRowText}>
                        <Text style={styles.wpTitle}>{f.kind} · {fmtTime(f.created_at)}</Text>
                        {f.note ? <Text style={styles.wpNote} numberOfLines={1}>{f.note}</Text> : null}
                      </View>
                    </TouchableOpacity>
                  )
                })}
              </ScrollView>
            </View>
          ) : panel === 'layers' ? (
            <View>
              <LayerToggle label="Terrain basemap" on={vis.basemap} disabled={!basemapMbtilesUrl} onPress={() => toggleVis('basemap')} />
              <LayerToggle label="Scored areas" on={vis.scored} onPress={() => toggleVis('scored')} />
              <LayerToggle label="Saved spots" on={vis.waypoints} onPress={() => toggleVis('waypoints')} />
              <LayerToggle label="My finds" on={vis.finds} onPress={() => toggleVis('finds')} />
              {!basemapMbtilesUrl && (
                <Text style={styles.panelMeta}>This bundle carried no basemap — only the scored areas and spots are shown.</Text>
              )}
            </View>
          ) : (
            <View>
              {fix ? (
                <Text style={styles.panelMeta}>
                  At {fix.lat.toFixed(5)}, {fix.lon.toFixed(5)}
                  {fix.accuracy != null ? `  ±${Math.round(fix.accuracy)} m` : ''}
                </Text>
              ) : (
                <Text style={styles.panelMeta}>Waiting for a GPS fix…</Text>
              )}
              <Text style={styles.formLabel}>Kind</Text>
              <View style={styles.kindRow}>
                {FIND_KINDS.map((k) => (
                  <TouchableOpacity
                    key={k}
                    style={[styles.kindChip, findKind === k && styles.kindChipOn]}
                    onPress={() => setFindKind(k)}
                  >
                    <Text style={[styles.kindChipText, findKind === k && styles.kindChipTextOn]}>{k}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.formLabel}>Note</Text>
              <TextInput
                style={styles.noteInput}
                value={findNote}
                onChangeText={setFindNote}
                placeholder="What did you see? (optional)"
                placeholderTextColor="#64748b"
                multiline
              />
              <Text style={styles.formLabel}>Photo</Text>
              {pendingPhotoUri ? (
                <View style={styles.photoRow}>
                  <Image source={{ uri: pendingPhotoUri }} style={styles.photoPreview} />
                  <View style={styles.photoActions}>
                    <TouchableOpacity onPress={addPhoto}>
                      <Text style={styles.photoActionText}>Retake</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setPendingPhotoUri(null)}>
                      <Text style={[styles.photoActionText, styles.photoRemoveText]}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity style={styles.addPhotoBtn} onPress={addPhoto}>
                  <Text style={styles.addPhotoText}>📷  Add photo</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.saveBtn, (!fix || savingFind) && styles.fabDisabled]}
                onPress={saveFind}
                disabled={!fix || savingFind}
              >
                <Text style={styles.saveBtnText}>{savingFind ? 'Saving…' : 'Save find here'}</Text>
              </TouchableOpacity>
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

      {/* Full-screen photo viewer — tap anywhere to dismiss. */}
      <Modal visible={!!viewerUri} transparent animationType="fade" onRequestClose={() => setViewerUri(null)}>
        <TouchableOpacity style={styles.viewerBackdrop} activeOpacity={1} onPress={() => setViewerUri(null)}>
          {viewerUri ? <Image source={{ uri: viewerUri }} style={styles.viewerImage} resizeMode="contain" /> : null}
        </TouchableOpacity>
      </Modal>
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

// One control in the bottom bar: an icon (in a round well) over a small label.
// `primary` gives the emerald filled well (the Log-find capture action); `active`
// tints the well/label when that button's panel is open.
function BarButton({
  icon,
  label,
  onPress,
  active,
  disabled,
  primary,
}: {
  icon: string
  label: string
  onPress: () => void
  active?: boolean
  disabled?: boolean
  primary?: boolean
}) {
  return (
    <TouchableOpacity style={styles.barBtn} onPress={onPress} disabled={disabled} accessibilityLabel={label}>
      <View
        style={[
          styles.barIconWell,
          primary && styles.barIconWellPrimary,
          active && !primary && styles.barIconWellActive,
          disabled && styles.barDisabled,
        ]}
      >
        <Text style={primary ? styles.barIconPrimary : styles.barIcon}>{icon}</Text>
      </View>
      <Text style={[styles.barLabel, active && styles.barLabelActive, disabled && styles.barDisabled]}>{label}</Text>
    </TouchableOpacity>
  )
}

// A find's photo thumbnail. Falls back to a placeholder if the file is missing or
// unreadable (e.g. an interrupted copy) instead of showing a broken image.
function PhotoThumb({ uri, onPress }: { uri: string; onPress: () => void }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <View style={[styles.findThumb, styles.thumbPlaceholder]}>
        <Text style={styles.thumbPlaceholderIcon}>📷</Text>
      </View>
    )
  }
  return (
    <TouchableOpacity onPress={onPress}>
      <Image source={{ uri }} style={styles.findThumb} onError={() => setFailed(true)} />
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  map: { flex: 1 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0e1726', padding: 24 },
  centerTitle: { color: '#ffffff', fontWeight: '700', fontSize: 18, marginBottom: 8 },
  centerText: { color: '#cbd5e1', fontSize: 14, textAlign: 'center', marginTop: 8 },

  fabDisabled: { opacity: 0.5 },

  // Bottom control bar
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(14,23,38,0.97)',
    paddingTop: 8,
    paddingBottom: 30,
    paddingHorizontal: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(148,163,184,0.25)',
  },
  barBtn: { flex: 1, alignItems: 'center', paddingTop: 2 },
  barIconWell: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  barIconWellActive: { backgroundColor: 'rgba(148,163,184,0.18)' },
  barIconWellPrimary: { backgroundColor: '#34d399' },
  barIcon: { fontSize: 22 },
  barIconPrimary: { fontSize: 26, color: '#06281e', fontWeight: '700', lineHeight: 28 },
  barDisabled: { opacity: 0.4 },
  barLabel: { color: '#94a3b8', fontSize: 11, marginTop: 3 },
  barLabelActive: { color: '#e2e8f0', fontWeight: '600' },

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

  formLabel: { color: '#cbd5e1', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14, marginBottom: 8 },
  kindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  kindChip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: 'rgba(148,163,184,0.15)', borderWidth: 1, borderColor: 'rgba(148,163,184,0.3)' },
  kindChipOn: { backgroundColor: 'rgba(52,211,153,0.2)', borderColor: '#34d399' },
  kindChipText: { color: '#cbd5e1', fontSize: 14, fontWeight: '600' },
  kindChipTextOn: { color: '#34d399' },
  noteInput: { color: '#e2e8f0', fontSize: 15, backgroundColor: 'rgba(148,163,184,0.12)', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, minHeight: 64, textAlignVertical: 'top' },
  saveBtn: { backgroundColor: '#34d399', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  saveBtnText: { color: '#06281e', fontSize: 16, fontWeight: '700' },

  // Log-find photo control
  addPhotoBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(148,163,184,0.45)',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: 'rgba(148,163,184,0.10)',
  },
  addPhotoText: { color: '#cbd5e1', fontSize: 15, fontWeight: '600' },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  photoPreview: { width: 64, height: 64, borderRadius: 8, backgroundColor: 'rgba(148,163,184,0.15)' },
  photoActions: { gap: 10 },
  photoActionText: { color: '#cbd5e1', fontSize: 15, fontWeight: '600' },
  photoRemoveText: { color: '#f87171' },

  // Find-list rows with optional thumbnail
  findRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(148,163,184,0.25)',
  },
  findRowText: { flex: 1 },
  findThumb: { width: 44, height: 44, borderRadius: 6, backgroundColor: 'rgba(148,163,184,0.15)' },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  thumbPlaceholderIcon: { fontSize: 20, opacity: 0.6 },

  // Full-screen photo viewer
  viewerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '100%' },
})
