import { useEffect, useRef, useState } from 'react'
import maplibregl, {
  type LayerSpecification,
  type StyleSpecification,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './MapView.css'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'
const TILE_BASE = import.meta.env.VITE_TILE_BASE ?? 'http://localhost:8080'

// I-70 corridor (Denver → Grand Junction).
const CENTER: [number, number] = [-106.4, 39.3]
const ZOOM = 6.6

// Self-hosted hillshade basemap (TileServer GL) under a dark fallback background.
// If hillshade.mbtiles isn't built yet, the raster tiles 404 (render transparent)
// and the dark background shows through — the map still works.
const BASE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    hillshade: {
      type: 'raster',
      tiles: [`${TILE_BASE}/data/hillshade/{z}/{x}/{y}.png`],
      tileSize: 256,
      attribution: 'Elevation: USGS 3DEP',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0e1726' } },
    { id: 'hillshade', type: 'raster', source: 'hillshade', paint: { 'raster-opacity': 0.9 } },
  ],
}

type LayerInfo = { id: string; label: string; group: 'overlay' | 'finds' }

// Draw order: fills (geology→context→targets), then lines, then points on top.
const LAYERS: LayerInfo[] = [
  { id: 'geology', label: 'Geologic map', group: 'overlay' },
  { id: 'ownership', label: 'Land ownership', group: 'overlay' },
  { id: 'potential', label: 'Mineral potential (CGS)', group: 'finds' },
  { id: 'districts', label: 'Historic mining districts', group: 'finds' },
  { id: 'forests', label: 'National forest boundaries', group: 'overlay' },
  { id: 'counties', label: 'County boundaries', group: 'overlay' },
  { id: 'roads', label: 'Roads (public + USFS)', group: 'overlay' },
  { id: 'trails', label: 'Trails (4WD + USFS)', group: 'overlay' },
  { id: 'aml', label: 'Mine hazards (AML)', group: 'finds' },
  { id: 'usmin', label: 'USMIN features', group: 'finds' },
  { id: 'mrds', label: 'MRDS mines', group: 'finds' },
]

// --- Unified "what are you looking for?" target -----------------------------
// Each curated target lights up whatever evidence exists for it: a mineral-
// potential favorability column (CGS) and/or a known-mine commodity (MRDS).
// Some targets only have one side (no silver potential layer; no MRDS rare-earth
// mines in the corridor) — that's surfaced via `note`.
type Gem = { name: string; desc: string }
type Target = {
  id: string
  label: string
  potentialCol: string | null // mineral_potential column, or null if none
  commodity: string | null // exact MRDS commodity facet, or null if none
  note?: string // surfaced when one side (potential / mines) has no data
  host?: string // the rock/mineral the gems come from — explains the mapping
  gems?: Gem[] // gem varieties, shown in an expandable "associated gems" card
}

const TARGETS: Target[] = [
  { id: 'gold', label: 'Gold', potentialCol: 'au_placer', commodity: 'Gold' },
  {
    id: 'silver',
    label: 'Silver',
    potentialCol: null,
    commodity: 'Silver',
    note: 'No potential layer for silver — showing known mines only.',
  },
  {
    id: 'pegmatite',
    label: 'Aquamarine & pegmatite gems',
    potentialCol: 'pegmatite',
    commodity: 'Beryllium',
    host: 'Pegmatite — coarse granite pods (and the Pikes Peak granite) where large gem crystals grow. Mines are catalogued under “Beryllium” (beryl is a beryllium mineral). Look in weathered, decomposed pegmatite and the pockets/“vugs” inside it.',
    gems: [
      { name: 'Aquamarine (blue beryl)', desc: 'Colorado’s state gem — Mount Antero (Chaffee) is the highest gem locality in North America.' },
      { name: 'Topaz', desc: 'Golden to clear; from pegmatite pockets and from rhyolite at Nathrop (Chaffee).' },
      { name: 'Amazonite', desc: 'Blue-green feldspar of the Pikes Peak granite, famously paired with smoky quartz (Park / Teller).' },
      { name: 'Smoky quartz', desc: 'Dark quartz commonly intergrown with amazonite and aquamarine.' },
      { name: 'Phenakite', desc: 'Rare colourless collector gem from beryl-rich pegmatites.' },
    ],
  },
  {
    id: 'corundum',
    label: 'Ruby & sapphire (corundum)',
    potentialCol: 'corundum',
    commodity: 'Gemstone',
    host: 'Corundum is the mineral; its gem varieties are ruby and sapphire. Mine dots use the broad “Gemstone” category (not corundum-specific).',
    gems: [
      { name: 'Ruby', desc: 'Red gem corundum, coloured by chromium.' },
      { name: 'Sapphire', desc: 'Blue — and also yellow, green, pink — gem corundum.' },
    ],
  },
  {
    id: 'rare_earth',
    label: 'Rare earths',
    potentialCol: 'rare_earth',
    commodity: null,
    note: 'No catalogued rare-earth mines in the corridor — showing potential only.',
  },
  { id: 'fluorite', label: 'Fluorite', potentialCol: 'fluorite', commodity: 'Fluorine-Fluorite' },
]

type Resolved = {
  potentialCol: string | null
  commodity: string | null
  isAny: boolean
  note?: string
  host?: string
  gems?: Gem[]
}

// Decode the target dropdown value into what each layer should do.
//   ''                -> Anything: all mines (by viewport), potential = placer gold
//   '<curated id>'    -> from the TARGETS table
//   'commodity:<raw>' -> a raw MRDS commodity (mines only, no potential)
function resolveTarget(target: string): Resolved {
  if (!target) return { potentialCol: 'au_placer', commodity: null, isAny: true }
  if (target.startsWith('commodity:')) {
    return { potentialCol: null, commodity: target.slice('commodity:'.length), isAny: false }
  }
  const t = TARGETS.find((x) => x.id === target)
  return {
    potentialCol: t?.potentialCol ?? null,
    commodity: t?.commodity ?? null,
    isAny: false,
    note: t?.note,
    host: t?.host,
    gems: t?.gems,
  }
}

// Favorability rating (1=low, 2=moderate, 3=high) → graduated amber.
function potentialColor(target: string): maplibregl.ExpressionSpecification {
  return ['match', ['get', target], 1, '#fde68a', 2, '#f59e0b', 3, '#b45309', 'rgba(0,0,0,0)']
}
function potentialFilter(target: string): maplibregl.FilterSpecification {
  return ['>', ['coalesce', ['get', target], 0], 0]
}
// An always-false filter — hides a layer that has no data for the current target.
const HIDE_ALL: maplibregl.FilterSpecification = ['==', 1, 0]

// --- Land ownership grouped by what matters for prospecting: access ----------
type OwnershipGroup = { label: string; short: string; color: string; managers: string[] }
const OWNERSHIP_GROUPS: OwnershipGroup[] = [
  {
    label: 'Federal — BLM / USFS (often allows recreational prospecting)',
    short: 'BLM/USFS',
    color: '#3f8f5f',
    managers: ['Bureau of Land Management', 'Forest Service'],
  },
  {
    label: 'Other federal (NPS / USFWS / … — varies, often restricted)',
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
    label: 'State (wildlife areas / parks — usually not allowed)',
    short: 'State',
    color: '#e0a030',
    managers: [
      'State Fish and Wildlife',
      'State Land Board',
      'State Park and Recreation',
      'Other or Unknown State Land',
    ],
  },
  {
    label: 'Local (city / county / regional)',
    short: 'Local',
    color: '#d9734e',
    managers: [
      'City Land',
      'County Land',
      'Regional Agency Land',
      'Regional Water Districts',
      'Other or Unknown Local Government',
    ],
  },
  {
    label: 'Private / NGO (need landowner permission)',
    short: 'Private',
    color: '#a8556b',
    managers: ['Private', 'Non-Governmental Organization'],
  },
  { label: 'Joint / unknown', short: 'Joint/Unk', color: '#94a3b8', managers: ['Joint', 'Unknown'] },
]

function ownershipColor(): maplibregl.ExpressionSpecification {
  const expr: unknown[] = ['match', ['get', 'manager_name']]
  for (const g of OWNERSHIP_GROUPS) expr.push(g.managers, g.color)
  expr.push('#64748b') // fallback for any manager not listed above
  return expr as maplibregl.ExpressionSpecification
}

function layerSpec(id: string): LayerSpecification {
  const source = `${id}-src`
  switch (id) {
    case 'geology':
      return {
        id,
        source,
        type: 'fill',
        paint: {
          'fill-color': [
            'match',
            ['get', 'generalized_lith'],
            'Igneous, intrusive', '#e388a3',
            'Igneous, volcanic', '#d1603d',
            // Group the metamorphic variants (gneiss, sed-clastic, mixed) under one hue.
            [
              'Metamorphic, undifferentiated',
              'Metamorphic, gneiss',
              'Metamorphic, sedimentary clastic',
              'Metamorphic and Sedimentary, undifferentiated',
            ], '#9b7cb6',
            'Sedimentary, clastic', '#d9c77e',
            'Sedimentary, carbonate', '#7fb5c9',
            'Sedimentary, undifferentiated', '#c9b97e',
            ['Unconsolidated, undifferentiated', 'Unconsolidated and Sedimentary, undifferentiated'], '#efe7b0',
            'Water', '#4a90d9',
            '#94a3b8',
          ],
          'fill-opacity': 0.5,
          'fill-outline-color': '#334155',
        },
      }
    case 'ownership':
      return {
        id,
        source,
        type: 'fill',
        paint: { 'fill-color': ownershipColor(), 'fill-opacity': 0.4 },
      }
    case 'potential':
      return {
        id,
        source,
        type: 'fill',
        filter: potentialFilter('au_placer'),
        paint: {
          'fill-color': potentialColor('au_placer'),
          'fill-opacity': 0.55,
          'fill-outline-color': '#92400e',
        },
      }
    case 'districts':
      return {
        id,
        source,
        type: 'fill',
        paint: {
          'fill-color': '#fcd34d',
          'fill-opacity': 0.28,
          'fill-outline-color': '#b45309',
        },
      }
    case 'forests':
      return {
        id,
        source,
        type: 'line',
        paint: { 'line-color': '#166534', 'line-width': 2, 'line-dasharray': [3, 2] },
      }
    case 'aml':
      return {
        id,
        source,
        type: 'circle',
        paint: {
          'circle-radius': 3,
          'circle-color': [
            'match',
            ['get', 'haz_rating'],
            'extreme danger', '#b91c1c',
            'dangerous', '#ef4444',
            'potential danger', '#f97316',
            '#9ca3af',
          ],
          'circle-stroke-color': '#1f2937',
          'circle-stroke-width': 0.5,
        },
      }
    case 'counties':
      return { id, source, type: 'line', paint: { 'line-color': '#e2e8f0', 'line-width': 1.4 } }
    case 'roads':
      return {
        id,
        source,
        type: 'line',
        paint: {
          'line-color': [
            'case',
            ['==', ['get', 'kind'], 'forest'],
            '#b45309',
            ['match', ['get', 'road_class'], 'Primary', '#f87171', '#fb923c'],
          ],
          'line-width': ['match', ['get', 'road_class'], 'Primary', 2.4, 1.3],
        },
      }
    case 'trails':
      return {
        id,
        source,
        type: 'line',
        paint: {
          'line-color': ['case', ['==', ['get', 'kind'], 'forest'], '#34d399', '#c4b5fd'],
          'line-width': 1,
          'line-dasharray': [2, 2],
        },
      }
    case 'usmin':
      return {
        id,
        source,
        type: 'circle',
        paint: { 'circle-radius': 2.4, 'circle-color': '#60a5fa', 'circle-opacity': 0.7 },
      }
    case 'mrds':
      return {
        id,
        source,
        type: 'circle',
        paint: {
          'circle-radius': 3.4,
          // Placer (cyan — stream gravels) vs lode/hard-rock (amber).
          'circle-color': ['match', ['get', 'dep_type'], ['Placer', 'Stream Placer'], '#22d3ee', '#fbbf24'],
          'circle-stroke-color': '#1f2937',
          'circle-stroke-width': 0.5,
        },
      }
    default:
      throw new Error(`no layer spec for ${id}`)
  }
}

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  )
}

// Normalize the messy raw USGS deposit-type labels for display (send raw value).
function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

const LAYER_LABEL: Record<string, string> = Object.fromEntries(LAYERS.map((l) => [l.id, l.label]))

const PROP_LABELS: Record<string, string> = {
  url: 'Source',
  web_page: 'Report (PDF)',
  unit_name: 'Unit Name',
  unit_age: 'Unit Age',
  unit_link: 'Unit Link',
  unit_desc: 'Description',
  orig_label: 'Map Label',
  generalized_lith: 'Generalized Lithology',
  rocktype1: 'Rock Type 1',
  rocktype2: 'Rock Type 2',
  rocktype3: 'Rock Type 3',
  manager_name: 'Manager',
  manager_type: 'Manager Type',
  owner_type: 'Owner Type',
  public_access: 'Public Access',
  as_of_date: 'As-of Date',
  county_geoid: 'County',
  county_1: 'County',
  county_2: 'County (2nd)',
  dev_stat: 'Development Status',
  dep_type: 'Deposit Type',
  commod1: 'Commodity 1',
  commod2: 'Commodity 2',
  commod3: 'Commodity 3',
  site_name: 'Site Name',
  ftr_type: 'Feature Type',
  ftr_name: 'Feature Name',
  topo_name: 'Topo Quad',
  topo_date: 'Topo Date',
  road_class: 'Road Class',
  forest_name: 'Forest',
  forest_code: 'Forest Code',
  hazard_kind: 'Hazard Kind',
  feature_type: 'Feature Type',
  haz_rating: 'Hazard Rating',
  env_rating: 'Environmental Rating',
  au_placer: 'Placer Gold Potential',
  pegmatite: 'Pegmatite Potential',
  corundum: 'Corundum Potential',
  rare_earth: 'Rare Earth Potential',
  fluorite: 'Fluorite Potential',
  formation: 'Formation',
  quad: 'Quadrangle',
}

function prettyLabel(key: string): string {
  return PROP_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function valueCell(value: string): string {
  if (/^https?:\/\//i.test(value)) {
    return `<a href="${esc(value)}" target="_blank" rel="noreferrer">Open ↗</a>`
  }
  return esc(value)
}

function featureRows(props: Record<string, unknown>): string {
  const skip = new Set(['id', 'state_fips'])
  return Object.entries(props)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== '')
    .map(([k, v]) => `<tr><td>${esc(prettyLabel(k))}</td><td>${valueCell(String(v))}</td></tr>`)
    .join('')
}

function popupHtml(features: maplibregl.MapGeoJSONFeature[]): string {
  const sections = features
    .map((f) => {
      const label = LAYER_LABEL[f.layer.id] ?? f.layer.id
      return `<div class="popup-sec"><h4>${esc(label)}</h4><table>${featureRows(f.properties ?? {})}</table></div>`
    })
    .join('')
  return `<div class="popup">${sections}</div>`
}

type Facets = { commodities: string[]; deposit_types: string[] }

// Heavy layers load by viewport (bbox). MRDS skips bbox when commodity-filtered
// (a filter is meant to find a target everywhere, not just on-screen).
const BBOX_LAYERS = new Set(['mrds', 'usmin', 'potential', 'aml'])
const PAN_LAYERS = ['usmin', 'potential', 'aml'] // mrds is handled separately

function bboxParam(map: maplibregl.Map): string {
  const b = map.getBounds()
  return `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`
}

// Walk a FeatureCollection's coordinates → [west, south, east, north]. Used to
// pin the map to the mapped area; derived from the data so it adapts if the
// ingested region grows (more counties).
function fcBounds(fc: GeoJSON.FeatureCollection): [number, number, number, number] {
  let w = 180
  let s = 90
  let e = -180
  let n = -90
  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return
    if (typeof coords[0] === 'number') {
      const [x, y] = coords as number[]
      if (x < w) w = x
      if (x > e) e = x
      if (y < s) s = y
      if (y > n) n = y
      return
    }
    for (const c of coords) visit(c)
  }
  for (const f of fc.features) {
    if (f.geometry && 'coordinates' in f.geometry) {
      visit((f.geometry as { coordinates: unknown }).coordinates)
    }
  }
  return [w, s, e, n]
}

function layerUrl(id: string, map: maplibregl.Map | null, commodity = '', depType = ''): string {
  const p = new URLSearchParams()
  const mrdsFiltered = id === 'mrds' && Boolean(commodity || depType)
  if (map && BBOX_LAYERS.has(id) && !mrdsFiltered) p.set('bbox', bboxParam(map))
  if (id === 'mrds') {
    if (commodity) p.set('commodity', commodity)
    if (depType) p.set('dep_type', depType)
  }
  const qs = p.toString()
  return `${API_BASE}/layers/${id}${qs ? `?${qs}` : ''}`
}

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

// AML mine openings have no structured open/closed field — derive one from the
// opening type + free-text comments so hazards can be filtered by closure status.
type Closure = 'collapsed' | 'closed' | 'unknown'
const CLOSURES: Closure[] = ['collapsed', 'closed', 'unknown']

function amlClosure(props: Record<string, unknown>): Closure {
  const c = String(props.comments ?? '').toLowerCase()
  const ft = String(props.feature_type ?? '').toLowerCase()
  if (ft.includes('subsidence') || /collaps|caved|cave[- ]?in|sloughed/.test(c)) return 'collapsed'
  if (/closed|backfill|seal|gated|grate|plug|fenced|secured|bat ?gate|capped|filled/.test(c)) return 'closed'
  return 'unknown'
}

// Tag each AML feature with its derived closure status (for client-side filtering).
function tagClosure(data: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  return {
    ...data,
    features: data.features.map((f) => ({
      ...f,
      properties: { ...(f.properties ?? {}), closure: amlClosure(f.properties ?? {}) },
    })),
  }
}

function amlFilter(s: Record<Closure, boolean>): maplibregl.FilterSpecification {
  const allowed = CLOSURES.filter((k) => s[k])
  return ['in', ['get', 'closure'], ['literal', allowed]] as maplibregl.FilterSpecification
}

type OpenMenu = 'overlays' | 'finds' | 'app' | null

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [visible, setVisible] = useState<Record<string, boolean>>(
    Object.fromEntries(LAYERS.map((l) => [l.id, true])),
  )
  const [status, setStatus] = useState('Loading layers…')
  const [facets, setFacets] = useState<Facets>({ commodities: [], deposit_types: [] })
  const [target, setTarget] = useState('') // '', curated id, or 'commodity:<raw>'
  const [depType, setDepType] = useState('')
  const [ready, setReady] = useState(false)
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [gemOpen, setGemOpen] = useState(false)
  const [amlStatus, setAmlStatus] = useState<Record<Closure, boolean>>({
    collapsed: true,
    closed: true,
    unknown: true,
  })

  const resolved = resolveTarget(target)

  // Populate the dropdowns from the real data.
  useEffect(() => {
    fetch(`${API_BASE}/layers/mrds/facets`)
      .then((r) => r.json())
      .then((f: Facets) => setFacets(f))
      .catch((err) => {
        console.error('facets load failed', err)
        setStatus(`Could not load filter options — is the API on ${API_BASE}?`)
      })
  }, [])

  // Target (or advanced deposit-type) change → recolor potential + re-query mines.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const { potentialCol, commodity, isAny } = resolveTarget(target)

    if (map.getLayer('potential')) {
      if (potentialCol) {
        map.setPaintProperty('potential', 'fill-color', potentialColor(potentialCol))
        map.setFilter('potential', potentialFilter(potentialCol))
      } else {
        map.setFilter('potential', HIDE_ALL)
      }
    }

    const src = map.getSource('mrds-src') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    if (!isAny && commodity === null) {
      src.setData(EMPTY_FC) // a target with no catalogued mines (e.g. rare earths)
      // Defer (not a synchronous setState in the effect body) to avoid cascading renders.
      queueMicrotask(() => setStatus('No catalogued mines for this target'))
      return
    }
    fetch(layerUrl('mrds', map, commodity ?? '', depType))
      .then((r) => r.json())
      .then((data: GeoJSON.FeatureCollection) => {
        src.setData(data)
        const filtered = commodity || depType ? ' (filtered)' : ''
        setStatus(`MRDS: ${data.features.length.toLocaleString()} sites${filtered}`)
      })
      .catch((err) => {
        console.error('MRDS load failed', err)
        setStatus('MRDS filter failed to load — check the API')
      })
  }, [target, depType, ready])

  // Reload the viewport-driven layers when the map settles (debounced).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    let timer: ReturnType<typeof setTimeout>
    const onMoveEnd = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const { commodity, isAny } = resolveTarget(target)
        const ids = isAny ? [...PAN_LAYERS, 'mrds'] : PAN_LAYERS // filtered mrds ignores viewport
        for (const id of ids) {
          const src = map.getSource(`${id}-src`) as maplibregl.GeoJSONSource | undefined
          if (!src) continue
          fetch(layerUrl(id, map, id === 'mrds' ? commodity ?? '' : '', id === 'mrds' ? depType : ''))
            .then((r) => r.json())
            .then((data: GeoJSON.FeatureCollection) => src.setData(id === 'aml' ? tagClosure(data) : data))
            .catch((err) => console.error(`reload of "${id}" failed`, err))
        }
      }, 300)
    }
    map.on('moveend', onMoveEnd)
    return () => {
      map.off('moveend', onMoveEnd)
      clearTimeout(timer)
    }
  }, [ready, target, depType])

  // Show/hide mine hazards by derived opening status (collapsed / closed / unknown).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !map.getLayer('aml')) return
    map.setFilter('aml', amlFilter(amlStatus))
  }, [amlStatus, ready])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE,
      center: CENTER,
      zoom: ZOOM,
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl(), 'top-right')

    map.on('load', async () => {
      let loaded = 0
      let countiesData: GeoJSON.FeatureCollection | null = null
      for (const { id } of LAYERS) {
        try {
          const res = await fetch(layerUrl(id, map))
          if (!res.ok) throw new Error(`${res.status}`)
          const data = (await res.json()) as GeoJSON.FeatureCollection
          if (id === 'counties') countiesData = data
          const srcData = id === 'aml' ? tagClosure(data) : data
          map.addSource(`${id}-src`, { type: 'geojson', data: srcData })
          map.addLayer(layerSpec(id))
          loaded += data.features.length
        } catch (err) {
          setStatus(`Failed to load "${id}": ${String(err)} — is the API on ${API_BASE}?`)
          return
        }
      }
      // Pin the view to the mapped area — can't pan or zoom out past it. Derived
      // from the counties extent, so adding counties widens the bounds for free.
      if (countiesData && countiesData.features.length) {
        const [w, s, e, n] = fcBounds(countiesData)
        const padX = (e - w) * 0.04 || 0.1
        const padY = (n - s) * 0.04 || 0.1
        const bounds: maplibregl.LngLatBoundsLike = [
          [w - padX, s - padY],
          [e + padX, n + padY],
        ]
        map.setMaxBounds(bounds)
        map.fitBounds(bounds, { animate: false, padding: 8 })
      }
      setStatus(`${loaded.toLocaleString()} features loaded`)
      setReady(true)
    })

    map.on('click', (e) => {
      const b = 5
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - b, e.point.y - b],
        [e.point.x + b, e.point.y + b],
      ]
      const feats = map.queryRenderedFeatures(box, { layers: LAYERS.map((l) => l.id) })
      if (!feats.length) return
      const order = [
        'mrds', 'usmin', 'aml', 'districts', 'potential',
        'roads', 'trails', 'geology', 'ownership', 'forests', 'counties',
      ]
      const picked = order
        .map((id) => feats.find((f) => f.layer.id === id))
        .filter((f): f is maplibregl.MapGeoJSONFeature => f !== undefined)
      if (!picked.length) return
      new maplibregl.Popup({ maxWidth: '340px', closeButton: true, closeOnClick: true })
        .setLngLat(e.lngLat)
        .setHTML(popupHtml(picked))
        .addTo(map)
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  function toggle(id: string) {
    const map = mapRef.current
    if (!map || !map.getLayer(id)) return
    const next = !visible[id]
    map.setLayoutProperty(id, 'visibility', next ? 'visible' : 'none')
    setVisible((v) => ({ ...v, [id]: next }))
  }

  function toggleMenu(name: Exclude<OpenMenu, null>) {
    setOpenMenu((cur) => (cur === name ? null : name))
  }

  const overlays = LAYERS.filter((l) => l.group === 'overlay')
  const finds = LAYERS.filter((l) => l.group === 'finds')

  return (
    <div className="map-root">
      <div ref={containerRef} className="map-canvas" />

      {/* Fixed top bar */}
      <header className="topbar">
        <span className="brand">Prospector's Compass</span>

        <div className="bar-item">
          <button className="bar-btn" onClick={() => toggleMenu('overlays')}>
            Overlays ▾
          </button>
          {openMenu === 'overlays' && (
            <div className="dropdown">
              {overlays.map((l) => (
                <label key={l.id} className="layer-toggle">
                  <input type="checkbox" checked={visible[l.id]} onChange={() => toggle(l.id)} />
                  {l.label}
                </label>
              ))}
              <a className="claims-link" href="https://mlrs.blm.gov/" target="_blank" rel="noreferrer">
                ⛏ Verify mining claims — BLM MLRS ↗
              </a>
            </div>
          )}
        </div>

        <div className="bar-item">
          <button className="bar-btn" onClick={() => toggleMenu('finds')}>
            Finds / Targets ▾
          </button>
          {openMenu === 'finds' && (
            <div className="dropdown wide">
              <label className="field">
                <span className="field-label">What are you looking for?</span>
                <select value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Anything (all mines)</option>
                  <optgroup label="Targets">
                    {TARGETS.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="All commodities (mines only)">
                    {facets.commodities.map((c) => (
                      <option key={c} value={`commodity:${c}`}>{c}</option>
                    ))}
                  </optgroup>
                </select>
              </label>
              {resolved.note && <p className="note">{resolved.note}</p>}

              {resolved.gems && resolved.gems.length > 0 && (
                <div className="gem-card">
                  <button className="gem-toggle" onClick={() => setGemOpen((o) => !o)}>
                    💎 Gems found here {gemOpen ? '▴' : '▾'}
                  </button>
                  {gemOpen && (
                    <div className="gem-body">
                      {resolved.host && <p className="gem-host">{resolved.host}</p>}
                      <ul>
                        {resolved.gems.map((g) => (
                          <li key={g.name}><b>{g.name}</b> — {g.desc}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <span className="field-label section">Show on map</span>
              {finds.map((l) => (
                <label key={l.id} className="layer-toggle">
                  <input type="checkbox" checked={visible[l.id]} onChange={() => toggle(l.id)} />
                  {l.label}
                </label>
              ))}

              {visible.mrds && (
                <label className="field advanced">
                  <span className="field-label">Advanced — deposit type</span>
                  <select value={depType} onChange={(e) => setDepType(e.target.value)}>
                    <option value="">Any</option>
                    {facets.deposit_types.map((d) => (
                      <option key={d} value={d}>{titleCase(d)}</option>
                    ))}
                  </select>
                </label>
              )}

              {visible.aml && (
                <div className="field advanced">
                  <span className="field-label">Mine hazard — opening status</span>
                  {CLOSURES.map((k) => (
                    <label key={k} className="layer-toggle">
                      <input
                        type="checkbox"
                        checked={amlStatus[k]}
                        onChange={() => setAmlStatus((s) => ({ ...s, [k]: !s[k] }))}
                      />
                      {k.charAt(0).toUpperCase() + k.slice(1)}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <span className="status-mini" title={status}>{status}</span>

        <button
          className="bar-btn bar-gear"
          aria-label="Settings & help"
          onClick={() => toggleMenu('app')}
        >
          <span className="gear">⚙</span>
          <span className="qmark">?</span>
        </button>
      </header>

      {/* Left ☰ menu */}
      {openMenu === 'app' && (
        <div className="app-menu">
          <button className="menu-item" disabled>⚙ Settings <span className="soon">soon</span></button>
          <button className="menu-item" disabled>👤 Profile <span className="soon">soon</span></button>
          <button className="menu-item" disabled>📲 Transfer to phone <span className="soon">soon</span></button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              setHelpOpen(true)
              setOpenMenu(null)
            }}
          >
            ❓ Help &amp; user manual
          </button>
        </div>
      )}

      {/* Click-away backdrop for any open bar menu */}
      {openMenu && <div className="backdrop" onClick={() => setOpenMenu(null)} />}

      {/* Persistent land-status disclaimer whenever ownership is shown */}
      {visible.ownership && (
        <div className="disclaimer-chip">
          ⚠ Land status is informational only — verify with the managing agency before digging.
        </div>
      )}

      {/* Active-layer legend */}
      <div className="legend-box">
        {visible.potential && resolved.potentialCol && (
          <div className="legend-row">
            <b>Potential</b>
            <span><i style={{ background: '#fde68a' }} />Low</span>
            <span><i style={{ background: '#f59e0b' }} />Mod</span>
            <span><i style={{ background: '#b45309' }} />High</span>
          </div>
        )}
        {visible.mrds && (
          <div className="legend-row">
            <b>Mines</b>
            <span><i style={{ background: '#22d3ee' }} />Placer</span>
            <span><i style={{ background: '#fbbf24' }} />Lode</span>
          </div>
        )}
        {visible.ownership && (
          <div className="legend-row">
            <b>Land</b>
            {OWNERSHIP_GROUPS.map((g) => (
              <span key={g.short} title={g.label}><i style={{ background: g.color }} />{g.short}</span>
            ))}
          </div>
        )}
        {visible.aml && (
          <div className="legend-row">
            <b>Hazards</b>
            <span><i style={{ background: '#f97316' }} />danger</span>
            <span><i style={{ background: '#b91c1c' }} />extreme</span>
          </div>
        )}
      </div>

      {/* Help / user manual */}
      {helpOpen && (
        <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
          <div className="help" onClick={(e) => e.stopPropagation()}>
            <button className="help-close" aria-label="Close" onClick={() => setHelpOpen(false)}>×</button>
            <h2>Prospector's Compass — field guide</h2>
            <p>
              A map of where to look for minerals in the Colorado I-70 corridor. Pan and zoom the map;
              click any feature for its details and source link.
            </p>

            <h3>What are you looking for?</h3>
            <p>
              Pick a <b>target</b> (in <i>Finds / Targets</i>) and the map focuses on it: the mineral-
              potential layer recolors to that target's favorability, and the known mines filter to it.
              Some targets only have one kind of evidence — e.g. there's no silver <i>potential</i> layer,
              and no catalogued rare-earth <i>mines</i> in the corridor; the map says so when that happens.
              Choose <i>Anything</i> to see all mines, or open <i>All commodities</i> to filter mines by any
              raw commodity.
            </p>

            <h3>Finds / targets</h3>
            <ul>
              <li><b>Mineral potential (CGS)</b> — favorability rating (low → high amber) for the chosen target.</li>
              <li><b>Historic mining districts</b> — proven-productive metal-mining ground.</li>
              <li><b>MRDS mines</b> — known mineral occurrences. <span className="k cyan" />placer (stream gravels) vs <span className="k amber" />lode (hard rock).</li>
              <li><b>USMIN features</b> — mine features digitized from historic topo maps.</li>
            </ul>

            <h3>Overlays</h3>
            <ul>
              <li><b>Geologic map</b> — bedrock colored by rock type.</li>
              <li><b>Land ownership</b> — colored by access-relevance (who manages it). See the disclaimer below.</li>
              <li><b>National forests / counties</b> — boundary context.</li>
              <li><b>Roads / trails</b> — public + USFS; primary roads are thicker.</li>
              <li><b>Mine hazards (AML)</b> — abandoned-mine hazards (orange → red by severity). Stay clear.</li>
            </ul>

            <h3>Land status</h3>
            <p>
              The ownership colors group land by whether prospecting is typically allowed — but they are
              <b> informational only</b>. Always verify land status and the local rules with the managing
              agency, and check mining claims via the BLM MLRS link, before digging.
            </p>

            <h3>Coming soon</h3>
            <p>Settings, profile, and transferring an area to the offline phone app.</p>
          </div>
        </div>
      )}
    </div>
  )
}
