import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  Linking,
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
  contoursFC,
  deleteTrip,
  importBundleFromUri,
  landFC,
  listTrips,
  loadActiveOrFixture,
  loadTrip,
  scoredCellsFC,
  setActiveTrip,
  waypointsFC,
  type LoadedTrip,
  type ScoredCell,
  type TripSummary,
  type Waypoint,
} from './src/bundle'
import { appendFind, buildFindsBundle, deleteFind, deleteFindsForTrip, findsFC, loadFinds, photoUri, savePhoto, type Find } from './src/finds'
import { addPin, deletePin, EMPTY_ANNOTATIONS, loadAnnotations, pinsFC, setNote, type Annotations, type DroppedPin } from './src/annotations'
import { bearingDegrees, cardinal16, distanceMeters, formatDistanceImperial } from './src/geo'
import * as Sharing from 'expo-sharing'
import { ensureBasemapDirs, ensureFonts, topoStyleIfAvailable } from './src/basemap'

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

// Land-ownership colors, mirrored verbatim from the desktop (MapView OWNERSHIP_GROUPS):
// parcels are colored by manager_name so private (need permission) reads distinctly
// from open BLM/USFS ground. Kept as a single source of truth for the fill + legend.
const LAND_GROUPS: { short: string; color: string; managers: string[] }[] = [
  { short: 'BLM/USFS', color: '#3f8f5f', managers: ['Bureau of Land Management', 'Forest Service'] },
  {
    short: 'Other fed',
    color: '#5b7fa8',
    managers: [
      'U.S. Fish and Wildlife Service',
      'Bureau of Reclamation',
      'Army Corps of Engineers',
      'National Park Service',
      'Department of Energy',
    ],
  },
  {
    short: 'State',
    color: '#e0a030',
    managers: ['State Fish and Wildlife', 'State Land Board', 'State Park and Recreation', 'Other or Unknown State Land'],
  },
  {
    short: 'Local',
    color: '#d9734e',
    managers: ['City Land', 'County Land', 'Regional Agency Land', 'Regional Water Districts', 'Other or Unknown Local Government'],
  },
  { short: 'Private', color: '#a8556b', managers: ['Private', 'Non-Governmental Organization'] },
  { short: 'Joint/Unk', color: '#94a3b8', managers: ['Joint', 'Unknown'] },
]
// The map fill mirrors these colors as an inline `match` on manager_name (see the
// land-fill Layer); LAND_GROUPS drives the Layers-panel legend so the two agree.

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
type LayerVis = { basemap: boolean; scored: boolean; waypoints: boolean; finds: boolean; contours: boolean; land: boolean }

// Quick-pick kinds for logging a field find (stored as the kind string).
const FIND_KINDS = ['Gold', 'Float', 'Outcrop', 'Other'] as const
// Emerald find markers — deliberately distinct from the magenta planned waypoints.
const FIND_COLOR = '#34d399'
// Violet markers for user-dropped pins — distinct from both of the above.
const DROPPED_PIN_COLOR = '#a855f7'

export default function App() {
  const [status, setStatus] = useState<'loading' | 'granted' | 'denied'>('loading')
  const [fix, setFix] = useState<Fix | null>(null)
  const [panel, setPanel] = useState<Panel>(null)

  // The loaded offline trip bundle (basemap + scored areas + waypoints).
  const [trip, setTrip] = useState<LoadedTrip | null>(null)
  const [tripError, setTripError] = useState<string | null>(null)
  const [vis, setVis] = useState<LayerVis>({ basemap: true, scored: true, waypoints: true, finds: true, contours: true, land: true })

  // Field finds logged on this phone (append-only, persisted locally per trip),
  // plus the in-progress log-a-find form state.
  const [finds, setFinds] = useState<Find[]>([])
  // Field annotations layered on the read-only bundle: notes on any pin + the
  // user's long-press-dropped pins (persisted locally per trip).
  const [annotations, setAnnotations] = useState<Annotations>(EMPTY_ANNOTATIONS)
  // Editable note text for the spot card's note field, seeded when a pin opens.
  const [noteDraft, setNoteDraft] = useState('')
  const [findKind, setFindKind] = useState<string>(FIND_KINDS[0])
  const [findNote, setFindNote] = useState('')
  const [savingFind, setSavingFind] = useState(false)
  const [sendingFinds, setSendingFinds] = useState(false)
  // Temp URI of a photo picked for the in-progress find (copied to permanent
  // storage only on Save), and the URI currently shown in the full-screen viewer.
  const [pendingPhotoUri, setPendingPhotoUri] = useState<string | null>(null)
  const [viewerUri, setViewerUri] = useState<string | null>(null)
  // The waypoint the user is navigating to (by id), or null. The bearing/distance
  // readout is derived live from this + the current GPS fix, so it updates as you
  // move without any extra subscription.
  const [navTargetId, setNavTargetId] = useState<number | null>(null)
  // The offline topo basemap style, if the sideloaded statewide vector base +
  // glyph fonts are present on the device (null → raster hillshade only).
  const [topoStyle, setTopoStyle] = useState<StyleSpecification | null>(null)
  // Every trip stored on the phone, for the trip picker (refreshed on load/import).
  const [trips, setTrips] = useState<TripSummary[]>([])
  // Keyboard height, so the bottom find-form panel can lift above the keyboard
  // (otherwise it covers the note field and the Save button).
  const [kbHeight, setKbHeight] = useState(0)

  // Index (into manifest.scored_areas.cells) of the scored cell the user tapped,
  // or null. We key off the index rather than the tapped feature's properties
  // because the rich factors/gates objects don't survive the native press
  // round-trip — only the plain `idx` integer does — so we re-look-up the full
  // cell in memory to render its rationale.
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  // The planned spot the user tapped (pin or trip list), or null. Shows its full
  // saved rationale (score/factors/gates) — the info that came with the spot.
  const [selectedWaypoint, setSelectedWaypoint] = useState<Waypoint | null>(null)

  const subRef = useRef<Location.LocationSubscription | null>(null)
  const cameraRef = useRef<CameraRef>(null)
  const mapRef = useRef<MapRef>(null)
  const didFit = useRef(false)

  // Load the offline trip bundle once on mount (unzips it into the documents dir
  // on first launch, then just reads it back). This is the keystone — until it
  // lands the map has nothing offline to show.
  useEffect(() => {
    let active = true
    loadActiveOrFixture()
      .then((loaded) => {
        if (!active) return
        setTrip(loaded)
        setTrips(listTrips())
      })
      .catch((err) => {
        console.error('trip load failed', err)
        if (active) setTripError(String(err?.message ?? err))
      })
    return () => {
      active = false
    }
  }, [])

  // Handle a .pcbundle opened from outside the app (AirDrop / Files → "Open in
  // Prospector's Compass"). iOS launches us with the file URL, or delivers it via
  // the 'url' event if we're already running; either way we import it in place of
  // the current trip. This is the real desktop→phone handoff.
  useEffect(() => {
    let active = true
    async function handleOpenUrl(url: string | null): Promise<void> {
      if (!active || !url || !url.startsWith('file://')) return
      try {
        const loaded = await importBundleFromUri(url)
        if (!active) return
        didFit.current = false // re-fit the camera to the new trip's footprint
        setNavTargetId(null)
        setPanel(null)
        setTripError(null)
        setTrip(loaded)
        setTrips(listTrips())
      } catch {
        Alert.alert('Couldn’t open trip', 'That file could not be read as a Prospector’s Compass trip.')
      }
    }
    Linking.getInitialURL().then(handleOpenUrl)
    const sub = Linking.addEventListener('url', (e) => handleOpenUrl(e.url))
    return () => {
      active = false
      sub.remove()
    }
  }, [])

  // Ensure the sideload dirs exist and pick up a topo base map if one is on the
  // device. Recomputed when the trip loads so the trip's shaded relief can be
  // layered UNDER the topo (terrain shows in the footprint; roads/labels on top).
  useEffect(() => {
    let active = true
    ensureBasemapDirs()
    const bm = trip?.manifest.basemap
    const hill =
      trip?.basemapMbtilesUrl && bm
        ? { url: trip.basemapMbtilesUrl, tileSize: bm.tile_size, minzoom: bm.minzoom, maxzoom: bm.maxzoom }
        : null
    // Restore the bundled glyph first (a no-op once present), THEN evaluate the
    // topo style — so a reinstall that wiped Documents/fonts still gets labels.
    ensureFonts().finally(() => {
      if (active) setTopoStyle(topoStyleIfAvailable(hill))
    })
    return () => {
      active = false
    }
  }, [trip])

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

  // Load this trip's field annotations (pin notes + dropped pins) alongside finds.
  useEffect(() => {
    if (!trip) return
    let active = true
    loadAnnotations(trip.manifest.trip.id)
      .then((a) => {
        if (active) setAnnotations(a)
      })
      .catch(() => {
        // None yet (or unreadable) — leave empty.
      })
    return () => {
      active = false
    }
  }, [trip])

  // Derive the map overlays from the manifest once (not on every render).
  const cellsFC = useMemo(() => (trip ? scoredCellsFC(trip.manifest) : null), [trip])
  const contoursFCData = useMemo(() => (trip ? contoursFC(trip.manifest) : null), [trip])
  const landFCData = useMemo(() => (trip ? landFC(trip.manifest) : null), [trip])
  const wpsFC = useMemo(() => (trip ? waypointsFC(trip.manifest) : null), [trip])
  const findsFCData = useMemo(() => findsFC(finds), [finds])
  const droppedPinsFC = useMemo(() => pinsFC(annotations.pins), [annotations.pins])

  // What's available to send back to the desktop: finds + dropped pins + notes on
  // planned pins (notes keyed to a dropped pin's id are counted under that pin).
  const pinCount = annotations.pins.length
  const plannedNoteCount = useMemo(() => {
    const droppedIds = new Set(annotations.pins.map((p) => String(p.id)))
    return Object.keys(annotations.notes).filter((k) => !droppedIds.has(k)).length
  }, [annotations.notes, annotations.pins])
  const hasFieldData = finds.length > 0 || pinCount > 0 || plannedNoteCount > 0
  const sendSummary = [
    finds.length ? `${finds.length} find${finds.length === 1 ? '' : 's'}` : '',
    pinCount ? `${pinCount} pin${pinCount === 1 ? '' : 's'}` : '',
    plannedNoteCount ? `${plannedNoteCount} note${plannedNoteCount === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(', ')

  // Seed the spot card's note field whenever a pin opens: show the locally-saved
  // note if there is one, else the note that rode in on the bundle.
  useEffect(() => {
    if (!selectedWaypoint) return
    setNoteDraft(annotations.notes[String(selectedWaypoint.id)] ?? selectedWaypoint.note ?? '')
    // Re-seed only when the selected pin changes, not on every keystroke/annotation edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWaypoint])

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

  // Delete a logged find. Finds are otherwise append-only, so a mis-tapped or
  // accidental find would be permanent; this is the one escape hatch. Always
  // behind a confirm (destructive + irreversible), and it also drops the photo.
  function confirmDeleteFind(f: Find): void {
    if (!trip) return
    const tripId = trip.manifest.trip.id
    Alert.alert(
      'Delete find?',
      `Removes "${f.kind}"${f.note ? ` (${f.note})` : ''}${f.photo ? ' and its photo' : ''}. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const gone = f.photo ? photoUri(tripId, f.photo) : null
            setFinds(await deleteFind(tripId, f.id))
            // Close the full-screen viewer if it was showing this find's photo.
            if (gone) setViewerUri((cur) => (cur === gone ? null : cur))
          },
        },
      ],
    )
  }

  // Bundle this trip's finds (notes + GPS + photos) into a .pcfinds file and open
  // the iOS share sheet so they can be AirDropped back to the desktop. This is the
  // return leg of the trip round-trip: the desktop sends spots out, the phone sends
  // discoveries home.
  async function sendFinds(): Promise<void> {
    if (!trip || finds.length === 0 || sendingFinds) return
    setSendingFinds(true)
    try {
      const uri = await buildFindsBundle(trip.manifest.trip.id, trip.manifest.trip.name)
      if (!uri) {
        Alert.alert('No finds to send', 'Log a find first, then send it to the desktop.')
        return
      }
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device can’t open the share sheet.')
        return
      }
      await Sharing.shareAsync(uri, {
        mimeType: 'application/zip',
        dialogTitle: 'Send field data to desktop',
        UTI: 'public.zip-archive',
      })
    } catch (e) {
      Alert.alert('Couldn’t send finds', String(e))
    } finally {
      setSendingFinds(false)
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
      // A planned spot's pin wins over the cell beneath it — tapping a spot should
      // show the spot's own saved rationale.
      const wpFeats = await mapRef.current.queryRenderedFeatures(pt, { layers: ['wp-circles'] })
      const wpId = wpFeats?.[0]?.properties?.id
      if (wpId != null) {
        const wp = trip?.manifest.trip.waypoints.find((w) => w.id === wpId) ?? null
        if (wp) {
          setSelectedWaypoint(wp)
          setSelectedIdx(null)
          setPanel(null)
          return
        }
      }
      // A dropped pin (user-placed): open it in the same card so it can be noted
      // or removed. Match the tapped feature id back to the stored pin.
      const pinFeats = await mapRef.current.queryRenderedFeatures(pt, { layers: ['dropped-circles'] })
      const pinId = pinFeats?.[0]?.properties?.id
      if (pinId != null) {
        const pin = annotations.pins.find((p) => String(p.id) === String(pinId))
        if (pin) {
          setSelectedWaypoint({ id: pin.id, lon: pin.lon, lat: pin.lat, title: pin.title, kind: 'manual', details: null, note: '' })
          setSelectedIdx(null)
          setPanel(null)
          return
        }
      }
      const feats = await mapRef.current.queryRenderedFeatures(pt, { layers: ['scored-fill'] })
      const raw = feats?.[0]?.properties?.idx
      const idx = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw
      if (typeof idx === 'number' && Number.isInteger(idx)) {
        setSelectedIdx(idx)
        setSelectedWaypoint(null)
        setPanel(null)
      } else {
        // tapped empty space — close any open card
        setSelectedIdx(null)
        setSelectedWaypoint(null)
      }
    } catch {
      // query failed (map not ready) — ignore
    }
  }

  // Long-press the map to drop a pin at that exact spot, then open its card so it
  // can be named/noted right away. Geographic coords come straight off the event.
  function onMapLongPress(e: { nativeEvent?: { lngLat?: [number, number] } }): void {
    const ll = e.nativeEvent?.lngLat
    if (!ll || !trip) return
    const [lon, lat] = ll
    const pin: DroppedPin = { id: Date.now(), lon, lat, title: 'Dropped pin', created_at: new Date().toISOString() }
    addPin(trip.manifest.trip.id, pin)
      .then(setAnnotations)
      .catch(() => Alert.alert('Couldn’t drop the pin', 'It could not be saved. Try again.'))
    setSelectedWaypoint({ id: pin.id, lon, lat, title: pin.title, kind: 'manual', details: null, note: '' })
    setSelectedIdx(null)
    setPanel(null)
  }

  // Save the spot card's note onto the selected pin (planned or dropped). Blank
  // clears it. Works for any pin because notes are keyed by waypoint id.
  async function saveWaypointNote(): Promise<void> {
    if (!trip || !selectedWaypoint) return
    try {
      setAnnotations(await setNote(trip.manifest.trip.id, String(selectedWaypoint.id), noteDraft))
      Keyboard.dismiss()
    } catch {
      Alert.alert('Couldn’t save the note', 'It could not be written. Try again.')
    }
  }

  // Delete a dropped pin (and its note), behind a confirm. Only offered for the
  // user's own dropped pins — planned spots come from the read-only bundle.
  function confirmDeleteDroppedPin(): void {
    if (!trip || !selectedWaypoint) return
    const tripId = trip.manifest.trip.id
    const pinId = Number(selectedWaypoint.id)
    Alert.alert('Delete pin?', 'Removes this dropped pin and its note. This can’t be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setAnnotations(await deletePin(tripId, pinId))
          setSelectedWaypoint(null)
        },
      },
    ])
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

  // Open a planned spot's detail card (its saved score/factors/gates/land status)
  // and center the map on it. The card is the full info that came with the spot.
  function openWaypoint(w: Waypoint): void {
    setSelectedWaypoint(w)
    setSelectedIdx(null)
    flyTo(w.lon, w.lat) // also closes the panel
  }

  // Start navigating to a waypoint: set it as the target and close the panel so
  // the on-map bearing/distance readout is visible. clearNav stops navigating.
  function navigateTo(w: Waypoint): void {
    setNavTargetId(w.id)
    setPanel(null)
  }
  function clearNav(): void {
    setNavTargetId(null)
  }

  // Open Apple Maps with DRIVING directions to a spot. Online by design — used at
  // home/trailhead with signal to navigate the drive in; once parked and off-grid,
  // the app's own offline map + bearing/distance readout takes over. Mirrors the
  // desktop popup's "Apple ↗" directions link.
  function openDirections(lat: number, lon: number): void {
    const url = `http://maps.apple.com/?daddr=${lat.toFixed(6)},${lon.toFixed(6)}&dirflg=d`
    Linking.openURL(url).catch(() =>
      Alert.alert('Couldn’t open Maps', 'Apple Maps could not be opened for directions.'),
    )
  }

  // Switch to another trip stored on the phone: persist it as active, reload its
  // cells/waypoints/finds/basemap, and re-fit the camera to its footprint.
  function switchTrip(id: number): void {
    if (id === trip?.manifest.trip.id) {
      setPanel(null)
      return
    }
    try {
      setActiveTrip(id)
      const loaded = loadTrip(id)
      didFit.current = false
      setNavTargetId(null)
      setTrip(loaded)
      setPanel(null)
    } catch {
      Alert.alert('Couldn’t open trip', 'That trip could not be loaded.')
    }
  }

  // Delete a trip and everything logged on it (finds + photos), behind a confirm.
  // If it was the active trip, fall back to another (or the re-seeded fixture).
  function confirmDeleteTrip(t: TripSummary): void {
    Alert.alert(
      'Delete trip?',
      `Removes "${t.name}" and everything logged on it (finds + photos). This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const wasActive = t.id === trip?.manifest.trip.id
            deleteTrip(t.id)
            deleteFindsForTrip(t.id)
            setTrips(listTrips())
            if (wasActive) {
              try {
                const loaded = await loadActiveOrFixture()
                didFit.current = false
                setNavTargetId(null)
                setTrip(loaded)
                setTrips(listTrips())
              } catch {
                // the deleted trip's files are gone; leave the current view as-is
              }
            }
          },
        },
      ],
    )
  }

  function toggleVis(key: keyof LayerVis): void {
    setVis((v) => ({ ...v, [key]: !v[key] }))
  }

  // Open (or toggle off) a panel. Always clears any open rationale card first so
  // the card and a panel never stack — the single place that enforces that
  // exclusion, instead of repeating it at every bar button.
  function openPanel(p: Exclude<Panel, null>): void {
    setSelectedIdx(null)
    setSelectedWaypoint(null)
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

  // Live navigation readout, derived (not stored) so it recomputes every render —
  // i.e. every time a fresh GPS fix lands. navTarget is the chosen waypoint (null
  // if none or it no longer exists); nav is the bearing/distance, null until we
  // have a fix to measure from. The trig is cheap, so no memoization is needed.
  const navTarget =
    navTargetId != null ? manifest.trip.waypoints.find((w) => w.id === navTargetId) ?? null : null
  const nav =
    navTarget && fix
      ? {
          // % 360 folds a rounded-up 359.5+ back to 0 (bearings read 0–359, not 360)
          bearing: Math.round(bearingDegrees(fix.lat, fix.lon, navTarget.lat, navTarget.lon)) % 360,
          distance: formatDistanceImperial(distanceMeters(fix.lat, fix.lon, navTarget.lat, navTarget.lon)),
        }
      : null

  return (
    <View style={styles.root}>
      {/* logo/attribution off: our four corner FABs leave no room for MapLibre's
          default ornaments (they sat UNDER the buttons), and the basemap is
          self-hosted public-domain USGS data, so no third-party attribution is
          owed. Data provenance lives in docs/DATA_SOURCES.md. */}
      <Map ref={mapRef} style={styles.map} mapStyle={topoStyle ?? OFFLINE_STYLE} logo={false} attribution={false} onPress={onMapPress} onLongPress={onMapLongPress}>
        <Camera ref={cameraRef} initialViewState={{ center: footprintCenter, zoom: 11.5 }} />

        {/* Offline shaded-relief basemap, read straight from the bundled MBTiles.
            Skipped when the topo vector base is active — an opaque raster on top
            would hide the topo roads/labels (terrain shading is a later layer). */}
        {!topoStyle && basemapMbtilesUrl && (
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

        {/* Land ownership from the bundle, colored by manager (private vs open
            BLM/USFS) so you can see whose ground you're on. Above the heat cells
            so boundaries read; a dark outline keeps parcel edges crisp. */}
        {landFCData && (
          <GeoJSONSource id="land" data={landFCData}>
            <Layer
              id="land-fill"
              type="fill"
              layout={{ visibility: vis.land ? 'visible' : 'none' }}
              paint={{
                'fill-color': [
                  'match',
                  ['get', 'manager_name'],
                  ['Bureau of Land Management', 'Forest Service'], '#3f8f5f',
                  ['U.S. Fish and Wildlife Service', 'Bureau of Reclamation', 'Army Corps of Engineers', 'National Park Service', 'Department of Energy'], '#5b7fa8',
                  ['State Fish and Wildlife', 'State Land Board', 'State Park and Recreation', 'Other or Unknown State Land'], '#e0a030',
                  ['City Land', 'County Land', 'Regional Agency Land', 'Regional Water Districts', 'Other or Unknown Local Government'], '#d9734e',
                  ['Private', 'Non-Governmental Organization'], '#a8556b',
                  ['Joint', 'Unknown'], '#94a3b8',
                  '#64748b',
                ],
                'fill-opacity': 0.32,
              }}
            />
            <Layer
              id="land-outline"
              type="line"
              layout={{ visibility: vis.land ? 'visible' : 'none' }}
              paint={{ 'line-color': 'rgba(15,23,42,0.55)', 'line-width': 1 }}
            />
          </GeoJSONSource>
        )}

        {/* Elevation contours from the bundle (40 ft lines; heavier 200 ft index
            lines carry a labelled elevation). Drawn over the heat cells so you can
            orient by terrain, under the markers. Labels need glyphs, so they only
            render with the topo base active. */}
        {contoursFCData && (
          <GeoJSONSource id="contours" data={contoursFCData}>
            <Layer
              id="contour-line"
              type="line"
              filter={['==', ['get', 'is_index'], false]}
              layout={{ visibility: vis.contours ? 'visible' : 'none' }}
              paint={{ 'line-color': '#6b3f1d', 'line-width': 1, 'line-opacity': 0.7 }}
            />
            <Layer
              id="contour-index"
              type="line"
              filter={['==', ['get', 'is_index'], true]}
              layout={{ visibility: vis.contours ? 'visible' : 'none' }}
              paint={{ 'line-color': '#4f2e15', 'line-width': 2, 'line-opacity': 0.9 }}
            />
          </GeoJSONSource>
        )}

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

        {/* User-dropped pins (long-press) — violet, distinct from magenta planned
            spots and emerald finds. Shown with the "Saved spots" toggle. */}
        <GeoJSONSource id="dropped" data={droppedPinsFC}>
          <Layer
            id="dropped-circles"
            type="circle"
            layout={{ visibility: vis.waypoints ? 'visible' : 'none' }}
            paint={{
              'circle-radius': 7,
              'circle-color': DROPPED_PIN_COLOR,
              'circle-stroke-color': '#ffffff',
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

      {/* Navigation HUD: bearing + distance to the chosen waypoint, live off the
          GPS fix. Shown only while a target is set; ✕ stops navigating. */}
      {navTarget && (
        <View style={styles.navHud}>
          <View style={styles.navHudText}>
            <Text style={styles.navHudTitle} numberOfLines={1}>
              ↗ {navTarget.title || navTarget.kind || `Spot ${navTarget.id}`}
            </Text>
            {nav ? (
              <Text style={styles.navHudReadout}>
                {nav.bearing}° {cardinal16(nav.bearing)} · {nav.distance}
              </Text>
            ) : (
              <Text style={styles.navHudReadout}>Acquiring GPS…</Text>
            )}
          </View>
          <TouchableOpacity
            style={styles.navHudGo}
            onPress={() => openDirections(navTarget.lat, navTarget.lon)}
            accessibilityLabel="Driving directions to this waypoint"
          >
            <Text style={styles.navHudGoText}>🧭</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={clearNav}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Stop navigating"
          >
            <Text style={styles.navHudClose}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

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
                {/* Trip library: switch between trips loaded onto the phone.
                    Shown only when there's more than one to choose from. */}
                {trips.length > 1 && (
                  <View>
                    <Text style={styles.gateHeading}>Trips on this phone</Text>
                    {trips.map((t) => {
                      const isActive = t.id === manifest.trip.id
                      return (
                        <View key={t.id} style={styles.tripRow}>
                          <TouchableOpacity
                            style={styles.findRowText}
                            onPress={() => switchTrip(t.id)}
                            disabled={isActive}
                            accessibilityLabel={`Open trip ${t.name}`}
                          >
                            <Text style={styles.wpTitle} numberOfLines={1}>{t.name}</Text>
                            <Text style={styles.wpNote} numberOfLines={1}>
                              {t.scoredCount} cells · {t.waypointCount} spot{t.waypointCount === 1 ? '' : 's'}
                            </Text>
                          </TouchableOpacity>
                          <Text style={isActive ? styles.tripActiveTag : styles.tripSwitchTag}>
                            {isActive ? 'Active' : 'Open'}
                          </Text>
                          <TouchableOpacity
                            style={styles.tripDelete}
                            onPress={() => confirmDeleteTrip(t)}
                            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                            accessibilityLabel={`Delete trip ${t.name}`}
                          >
                            <Text style={styles.findDeleteText}>✕</Text>
                          </TouchableOpacity>
                        </View>
                      )
                    })}
                  </View>
                )}
                <Text style={styles.gateHeading}>Planned spots</Text>
                {manifest.trip.waypoints.length === 0 && (
                  <Text style={styles.panelBody}>No saved spots in this trip yet.</Text>
                )}
                {manifest.trip.waypoints.map((w) => {
                  const label = w.title || w.kind || `Spot ${w.id}`
                  const active = navTargetId === w.id
                  return (
                    <View key={w.id} style={styles.wpRow}>
                      <TouchableOpacity style={styles.wpRowText} onPress={() => openWaypoint(w)}>
                        <Text style={styles.wpTitle}>{label}</Text>
                        {!!w.note && <Text style={styles.wpNote} numberOfLines={1}>{w.note}</Text>}
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.wpDirections}
                        onPress={() => openDirections(w.lat, w.lon)}
                        accessibilityLabel={`Driving directions to ${label}`}
                      >
                        <Text style={styles.wpDirectionsText}>🧭</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.wpGo, active && styles.wpGoActive]}
                        onPress={() => navigateTo(w)}
                        accessibilityLabel={`Navigate to ${label}`}
                      >
                        <Text style={[styles.wpGoText, active && styles.wpGoTextActive]}>
                          {active ? 'Navigating' : '↗ Go'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )
                })}
                <Text style={styles.gateHeading}>Your finds</Text>
                {finds.length === 0 && (
                  <Text style={styles.panelBody}>No finds yet. Tap ＋ to log one where you stand.</Text>
                )}
                {hasFieldData && (
                  <TouchableOpacity
                    style={[styles.sendFindsBtn, sendingFinds && styles.sendFindsBtnBusy]}
                    onPress={sendFinds}
                    disabled={sendingFinds}
                  >
                    <Text style={styles.sendFindsText}>
                      {sendingFinds ? 'Preparing…' : `📤 Send to desktop (${sendSummary})`}
                    </Text>
                  </TouchableOpacity>
                )}
                {/* Newest first — the find you just logged is the one you want. */}
                {[...finds].reverse().map((f) => {
                  const thumb = f.photo ? photoUri(manifest.trip.id, f.photo) : null
                  return (
                    <View key={f.id} style={styles.findRow}>
                      {thumb ? <PhotoThumb uri={thumb} onPress={() => setViewerUri(thumb)} /> : null}
                      <TouchableOpacity style={styles.findRowText} onPress={() => flyTo(f.lon, f.lat)}>
                        <Text style={styles.wpTitle}>{f.kind} · {fmtTime(f.created_at)}</Text>
                        {f.note ? <Text style={styles.wpNote} numberOfLines={1}>{f.note}</Text> : null}
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.findDelete}
                        onPress={() => confirmDeleteFind(f)}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        accessibilityLabel={`Delete ${f.kind} find`}
                      >
                        <Text style={styles.findDeleteText}>✕</Text>
                      </TouchableOpacity>
                    </View>
                  )
                })}
              </ScrollView>
            </View>
          ) : panel === 'layers' ? (
            <ScrollView style={styles.layersList}>
              {/* All toggles first so they're always visible together; the land
                  legend + disclaimer go below and scroll (they can't be clipped). */}
              <LayerToggle label="Terrain basemap" on={vis.basemap} disabled={!basemapMbtilesUrl} onPress={() => toggleVis('basemap')} />
              <LayerToggle label="Scored areas" on={vis.scored} onPress={() => toggleVis('scored')} />
              <LayerToggle label="Land status" on={vis.land} onPress={() => toggleVis('land')} />
              <LayerToggle label="Contour lines" on={vis.contours} onPress={() => toggleVis('contours')} />
              <LayerToggle label="Saved spots" on={vis.waypoints} onPress={() => toggleVis('waypoints')} />
              <LayerToggle label="My finds" on={vis.finds} onPress={() => toggleVis('finds')} />
              {vis.land && (
                <View style={styles.landLegend}>
                  {LAND_GROUPS.map((g) => (
                    <View key={g.short} style={styles.landLegendRow}>
                      <View style={[styles.landSwatch, { backgroundColor: g.color }]} />
                      <Text style={styles.landLegendText}>{g.short}</Text>
                    </View>
                  ))}
                </View>
              )}
              {vis.land && <Text style={styles.landDisc}>{LAND_STATUS_DISCLAIMER}</Text>}
              {!basemapMbtilesUrl && (
                <Text style={styles.panelMeta}>This bundle carried no basemap — only the scored areas and spots are shown.</Text>
              )}
            </ScrollView>
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
          <TouchableOpacity
            style={styles.directionsBtn}
            onPress={() => openDirections(selectedCell.lat, selectedCell.lon)}
            accessibilityLabel="Driving directions to this spot"
          >
            <Text style={styles.directionsBtnText}>🧭  Directions (Apple Maps)</Text>
          </TouchableOpacity>
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

      {/* Planned-spot detail card: the FULL saved info that came with the spot —
          score, factor breakdown, land-status gates — plus Directions + Navigate.
          Opened by tapping the pin on the map or the spot in the Trip list. */}
      {selectedWaypoint && (
        <View style={[styles.panel, kbHeight > 0 && { bottom: 116 + kbHeight }]}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle} numberOfLines={1}>
              {selectedWaypoint.title || selectedWaypoint.kind || 'Planned spot'}
            </Text>
            <TouchableOpacity onPress={() => setSelectedWaypoint(null)} accessibilityLabel="Close">
              <Text style={styles.panelClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.panelMeta}>
            {selectedWaypoint.details?.score != null ? `Score ${Math.round(selectedWaypoint.details.score)} · ` : ''}
            {selectedWaypoint.details?.band ? `${humanize(selectedWaypoint.details.band)} confidence · ` : ''}
            {selectedWaypoint.lat.toFixed(5)}, {selectedWaypoint.lon.toFixed(5)}
          </Text>
          {/* Editable note — works on any pin (planned or dropped). Blank clears it. */}
          <TextInput
            style={styles.noteInput}
            value={noteDraft}
            onChangeText={setNoteDraft}
            placeholder="Add a note to this spot…"
            placeholderTextColor="#64748b"
            multiline
          />
          <TouchableOpacity style={styles.wpNoteSave} onPress={() => void saveWaypointNote()} accessibilityLabel="Save note">
            <Text style={styles.wpNoteSaveText}>Save note</Text>
          </TouchableOpacity>
          <View style={styles.wpCardActions}>
            <TouchableOpacity
              style={styles.directionsBtn}
              onPress={() => openDirections(selectedWaypoint.lat, selectedWaypoint.lon)}
              accessibilityLabel="Driving directions to this spot"
            >
              <Text style={styles.directionsBtnText}>🧭  Directions</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.wpCardGo}
              onPress={() => {
                navigateTo(selectedWaypoint)
                setSelectedWaypoint(null)
              }}
              accessibilityLabel="Navigate to this spot"
            >
              <Text style={styles.wpCardGoText}>↗ Navigate</Text>
            </TouchableOpacity>
            {annotations.pins.some((p) => p.id === selectedWaypoint.id) && (
              <TouchableOpacity
                style={styles.wpDeleteBtn}
                onPress={confirmDeleteDroppedPin}
                accessibilityLabel="Delete this dropped pin"
              >
                <Text style={styles.wpDeleteText}>🗑 Delete pin</Text>
              </TouchableOpacity>
            )}
          </View>
          {(selectedWaypoint.details?.factors ?? []).length > 0 && (
            <Text style={styles.rationaleSub}>Each factor adds points, then access gates multiply.</Text>
          )}
          <ScrollView style={styles.wpList}>
            {[...(selectedWaypoint.details?.factors ?? [])]
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
            {(selectedWaypoint.details?.gates ?? []).length > 0 && (
              <View>
                <Text style={styles.gateHeading}>Land status</Text>
                {(selectedWaypoint.details?.gates ?? []).map((g) => (
                  <View key={g.name} style={styles.factorRow}>
                    <View style={styles.factorHead}>
                      <Text style={styles.factorLabel}>{humanize(g.name)}</Text>
                      <Text style={[styles.gateState, g.gate >= 1 ? styles.gateOpen : styles.gateRestricted]}>×{g.gate}</Text>
                    </View>
                    <Text style={styles.factorRaw}>{g.raw}</Text>
                  </View>
                ))}
                <Text style={styles.landDisc}>{LAND_STATUS_DISCLAIMER}</Text>
              </View>
            )}
            {(selectedWaypoint.details?.factors ?? []).length === 0 && (
              <Text style={styles.panelBody}>No saved scoring breakdown for this spot.</Text>
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

  // Navigation HUD (bearing + distance to a waypoint), stacked under the pill
  navHud: {
    position: 'absolute',
    top: 120,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    maxWidth: 300,
    backgroundColor: 'rgba(6,40,30,0.95)',
    borderWidth: 1,
    borderColor: '#34d399',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  navHudText: { flexShrink: 1 },
  navHudTitle: { color: '#ffffff', fontWeight: '700', fontSize: 14 },
  // tabular-nums keeps the digits from jittering as the readout updates
  navHudReadout: { color: '#6ee7b7', fontSize: 16, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums'] },
  navHudClose: { color: '#cbd5e1', fontSize: 18, fontWeight: '600' },
  navHudGo: { paddingHorizontal: 6, paddingVertical: 2 },
  navHudGoText: { fontSize: 18 },

  panel: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 116,
    maxHeight: 420,
    backgroundColor: 'rgba(14,23,38,0.96)',
    borderRadius: 16,
    padding: 18,
  },
  panelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  panelTitle: { color: '#ffffff', fontWeight: '700', fontSize: 16, flexShrink: 1, paddingRight: 8 },
  panelClose: { color: '#cbd5e1', fontSize: 18, paddingHorizontal: 6 },
  panelBody: { color: '#cbd5e1', fontSize: 14, lineHeight: 20 },
  panelMeta: { color: '#94a3b8', fontSize: 12, marginBottom: 10, lineHeight: 17 },

  sendFindsBtn: {
    backgroundColor: 'rgba(52, 211, 153, 0.16)',
    borderColor: FIND_COLOR,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    alignItems: 'center',
  },
  sendFindsBtnBusy: { opacity: 0.6 },
  sendFindsText: { color: FIND_COLOR, fontWeight: '700', fontSize: 14 },

  wpList: { maxHeight: 250 },
  layersList: { maxHeight: 320 },
  wpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(148,163,184,0.25)',
  },
  wpRowText: { flex: 1 },
  wpTitle: { color: '#e2e8f0', fontSize: 15, fontWeight: '600' },
  wpNote: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  wpGo: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#34d399',
  },
  wpGoActive: { backgroundColor: '#34d399', borderColor: '#34d399' },
  wpGoText: { color: '#34d399', fontSize: 13, fontWeight: '700' },
  wpGoTextActive: { color: '#06281e' },
  wpDirections: { paddingHorizontal: 8, paddingVertical: 4 },
  wpDirectionsText: { fontSize: 16 },
  // "Directions" button on the rationale card (drive to a tapped score cell)
  directionsBtn: {
    alignSelf: 'flex-start',
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#60a5fa',
    backgroundColor: 'rgba(96,165,250,0.12)',
  },
  directionsBtnText: { color: '#93c5fd', fontSize: 14, fontWeight: '700' },
  wpCardActions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  wpCardGo: {
    alignSelf: 'flex-start',
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#34d399',
    backgroundColor: 'rgba(52,211,153,0.12)',
  },
  wpCardGoText: { color: '#34d399', fontSize: 14, fontWeight: '700' },
  wpNoteSave: { backgroundColor: '#34d399', borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginTop: 8, marginBottom: 12 },
  wpNoteSaveText: { color: '#06281e', fontSize: 14, fontWeight: '700' },
  wpDeleteBtn: {
    alignSelf: 'flex-start',
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#7f1d1d',
    backgroundColor: 'rgba(127,29,29,0.25)',
  },
  wpDeleteText: { color: '#fca5a5', fontSize: 14, fontWeight: '700' },

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
  landLegend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8, paddingLeft: 4 },
  landLegendRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  landSwatch: { width: 12, height: 12, borderRadius: 3 },
  landLegendText: { color: '#cbd5e1', fontSize: 12 },

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
  tripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(148,163,184,0.25)',
  },
  tripActiveTag: { color: '#34d399', fontSize: 12, fontWeight: '700' },
  tripSwitchTag: { color: '#cbd5e1', fontSize: 12, fontWeight: '600' },
  tripDelete: { paddingHorizontal: 6, paddingVertical: 4 },
  findDelete: { paddingHorizontal: 8, paddingVertical: 4 },
  findDeleteText: { color: '#f87171', fontSize: 17, fontWeight: '600' },
  findThumb: { width: 44, height: 44, borderRadius: 6, backgroundColor: 'rgba(148,163,184,0.15)' },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  thumbPlaceholderIcon: { fontSize: 20, opacity: 0.6 },

  // Full-screen photo viewer
  viewerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '100%' },
})
