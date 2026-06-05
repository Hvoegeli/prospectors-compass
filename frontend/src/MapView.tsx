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

// Menu group: 'finds' = where minerals are proven/likely; 'land' = land status &
// claims (can I be/dig here); 'access' = getting there + the ground. The target
// SELECTOR lives in its own "Looking for" menu (it's not a layer toggle).
type LayerInfo = { id: string; label: string; group: 'finds' | 'land' | 'access' }

// Array order is the map DRAW order (fills first, then lines, then points on
// top) — keep it; only `group` controls which menu a layer appears under.
const LAYERS: LayerInfo[] = [
  { id: 'geology', label: 'Geologic map', group: 'access' },
  { id: 'ownership', label: 'Land ownership', group: 'land' },
  { id: 'potential', label: 'Mineral potential (CGS)', group: 'finds' },
  { id: 'districts', label: 'Historic mining districts', group: 'finds' },
  { id: 'claims', label: 'Active mining claims (BLM)', group: 'land' },
  { id: 'forests', label: 'National forest boundaries', group: 'land' },
  { id: 'counties', label: 'County boundaries', group: 'access' },
  { id: 'streams', label: 'Streams & rivers', group: 'access' },
  { id: 'roads', label: 'Roads (public + USFS)', group: 'access' },
  { id: 'trails', label: 'Trails (4WD + USFS)', group: 'access' },
  { id: 'faults', label: 'Faults (lode structure)', group: 'finds' },
  { id: 'aml', label: 'Mine hazards (AML)', group: 'access' },
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
    case 'claims':
      // Red = "already staked" — a warning hue, kept low-opacity with a strong
      // outline so the underlying terrain/potential still reads through.
      return {
        id,
        source,
        type: 'fill',
        paint: {
          'fill-color': '#ef4444',
          'fill-opacity': 0.16,
          'fill-outline-color': '#b91c1c',
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
    case 'streams':
      // Main perennial creeks, rivers & streams (year-round water for panning).
      return {
        id,
        source,
        type: 'line',
        paint: { 'line-color': '#3b82f6', 'line-width': 1.2, 'line-opacity': 0.85 },
      }
    case 'faults':
      // Structural faults (lode control), drawn as a distinct violet dashed line.
      return {
        id,
        source,
        type: 'line',
        paint: { 'line-color': '#a855f7', 'line-width': 1, 'line-dasharray': [4, 2] },
      }
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
  flow_type: 'Flow',
  env_rating: 'Environmental Rating',
  au_placer: 'Placer Gold Potential',
  pegmatite: 'Pegmatite Potential',
  corundum: 'Corundum Potential',
  rare_earth: 'Rare Earth Potential',
  fluorite: 'Fluorite Potential',
  formation: 'Formation',
  quad: 'Quadrangle',
  serial_nr: 'Claim Serial #',
  claim_name: 'Claim Name',
  claim_type: 'Claim Type',
  case_group: 'Case Group',
  case_disp: 'Disposition',
  acres: 'Acres',
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
  const skip = new Set(['id', 'state_fips', 'nhd_id']) // nhd_id is an ugly provenance GUID
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
const BBOX_LAYERS = new Set(['mrds', 'usmin', 'potential', 'aml', 'claims', 'streams'])
const PAN_LAYERS = ['usmin', 'potential', 'aml', 'claims', 'streams'] // mrds is handled separately

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

// Drop out-of-order async responses: bump a per-source counter before each fetch
// and ignore any response whose counter is no longer the latest for that source.
function nextReq(seqs: Record<string, number>, id: string): number {
  return (seqs[id] = (seqs[id] ?? 0) + 1)
}

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

// --- Field guide: a non-AI, deterministic beginner's prospecting reference ----
// (project scope calls for a "non-AI field guide / dichotomous key"). Pure static
// text — no network, no model — rendered as a collapsible top-bar menu.
type GuideEntry = { id: string; title: string; body: string[] }
type GuideCategory = { name: string; entries: GuideEntry[] }
const FIELD_GUIDE: GuideCategory[] = [
  {
    name: 'Targets — what to look for & where',
    entries: [
      {
        id: 'placer',
        title: '🪙 Placer gold (creeks, streams & rivers)',
        body: [
          'Gold is about 19× heavier than water, so moving water drops it the instant the current slows — hunt the slow spots.',
          'Best traps: the inside of bends, behind and downstream of boulders, in bedrock cracks and crevices, at the base of waterfalls and rapids, and where a steep creek flattens out.',
          'Dig down to bedrock (or a packed clay "false bedrock") — gold works its way to the bottom of the gravel.',
          'Black sand (magnetite) piling up in your pan means you are in a gold-catching zone; gold rides with it.',
          'Work downstream of known lode sources and historic districts — gold does not travel far from where it eroded out.',
        ],
      },
      {
        id: 'lode',
        title: '⛏️ Lode gold (hard rock)',
        body: [
          'The original source: gold in quartz veins along faults and fractures, often with rusty iron staining ("gossan") and sulfides like pyrite.',
          'Trace placer gold upstream to find the lode that shed it.',
          'Look in and near historic districts (the Mining districts layer) where veins cut favorable rock.',
        ],
      },
      {
        id: 'silver',
        title: '🪙 Silver',
        body: [
          'Usually in hydrothermal veins with lead and zinc — watch for galena (heavy, bright lead-gray cubes) and sphalerite.',
          'Common around old volcanic centers (epithermal deposits); Colorado has famous silver camps like Leadville and Aspen.',
          'Often a by-product of lead / zinc / copper ground — check polymetallic past-producers.',
        ],
      },
      {
        id: 'platinum',
        title: '⚪ Platinum (PGE)',
        body: [
          'Tied to dark, iron- and magnesium-rich (mafic / ultramafic) intrusions and their placers; it travels with chromite and olivine.',
          'Rare in Colorado — more "know it when the geology is right" than a primary local target. Do not chase it here without a strong reason.',
        ],
      },
      {
        id: 'gems',
        title: '💎 Gemstones in their host rock',
        body: [
          'Pegmatites (very coarse granite — you can see individual crystals) are the prime host for aquamarine / beryl, topaz, tourmaline, smoky quartz, and garnet.',
          'Look for pockets and vugs, and weathered "rotten" pegmatite where crystals wash loose (Mt. Antero, Crystal Peak).',
          'Corundum (ruby and sapphire) forms in metamorphic rock — marble, gneiss, schist.',
          'Cavities, vugs, and contact zones (where an intrusion meets the country rock) concentrate crystals. Check the Mineral potential layer for pegmatite / corundum favorability.',
        ],
      },
      {
        id: 'copper',
        title: '🟢 Copper & malachite',
        body: [
          'The tell is color: bright green (malachite) and blue (azurite) stains are copper carbonates — weathering products that flag copper sulfides below.',
          'Look for gossans (rusty caps) and green-stained fractures in outcrops, roadcuts, and old mine dumps.',
          'Copper turns up in vein, porphyry, and sediment-hosted systems; green staining is your quick visual cue.',
        ],
      },
    ],
  },
  {
    name: 'Skills',
    entries: [
      {
        id: 'panning',
        title: '🥄 Panning & basic gear',
        body: [
          'Starter kit: a gold pan, a classifier (sieve), a snuffer bottle, and a small vial. A plastic pan with riffles is fine to learn on.',
          'Technique: fill the pan with gravel, submerge it, break up any clay, shake side-to-side to settle the heavies, then tip and swirl to wash the light material off the top — a little at a time. Gold stays at the back and bottom.',
          'Classify first (screen out the big rocks) so you are panning the fine material where the gold is.',
          'Check what is legal to use: a pan and hand sluice are usually fine; motorized dredging is often restricted or needs a permit — verify before you go.',
        ],
      },
      {
        id: 'identify',
        title: '🔍 Identify your find (field tests)',
        body: [
          'Heft — real gold feels surprisingly heavy for its size.',
          'Hardness — a scratch test sorts look-alikes (a steel knife is about 5.5 on the Mohs hardness scale).',
          'Streak — rub it on unglazed porcelain: gold leaves a gold streak; pyrite ("fool\'s gold") leaves a greenish-black streak.',
          'Magnetism — a magnet pulls magnetite (black sand) but not gold.',
          'The classic call: gold is heavy, soft, and malleable (it dents, it will not shatter) with no streak; pyrite is brittle and shatters; mica is light and flakes or floats.',
          'If you cannot confidently identify it, treat it as unknown and run more tests — do not guess.',
        ],
      },
      {
        id: 'reading-map',
        title: '🗺️ Reading this map (combine the layers)',
        body: [
          'A good prospect is where several signals stack up: high Mineral potential for your target, a known mine nearby, a drainage below a lode, open land (BLM / USFS), and a road or trail to reach it.',
          'Start from a historic district or a high-potential unit, then follow the water downhill for placer, or the vein / contact for lode.',
          'Always check Land ownership and Active claims before planning a trip, and note nearby Mine hazards.',
        ],
      },
    ],
  },
  {
    name: 'Stay safe & legal',
    entries: [
      {
        id: 'safety',
        title: '⚠️ Safety',
        body: [
          'Never enter an abandoned mine — adits and shafts collapse, flood, and hold bad air. The Mine hazards (AML) layer shows them; stay out and clear of the openings.',
          'Backcountry basics: tell someone your route and return time, carry water and layers, watch the weather (afternoon storms, flash floods in drainages), and expect no cell service.',
          'Old workings have unstable dumps, hidden openings, and rotten timber — watch your footing.',
        ],
      },
      {
        id: 'legal',
        title: '📜 Legal & etiquette',
        body: [
          'Rockhounding vs. claiming: casual collecting for personal use is generally allowed on much BLM and Forest Service land, but rules differ by area and forest — check first.',
          'Respect active claims: the Active claims layer shows ground others legally control; do not prospect or collect there.',
          'Fill your holes and pack out trash — leave no trace; reclamation is not optional on public land.',
          'No collecting in National Parks, Wilderness, and most state parks and wildlife areas. When in doubt, ask the managing agency — land status here is informational, so verify it.',
        ],
      },
    ],
  },
  {
    name: 'Reference',
    entries: [
      {
        id: 'glossary',
        title: '📒 Glossary',
        body: [
          'Placer — mineral (especially gold) concentrated in stream and river gravels by water.',
          'Lode — mineral still in its source rock, e.g. a quartz vein; "hard rock."',
          'Pay streak — the concentrated line of gold within a deposit.',
          'Gossan — a rusty, iron-stained weathered cap over a sulfide body; a pathfinder.',
          'Float — loose pieces of ore eroded from a source; trace it uphill to find it.',
          'Bench / terrace — old, elevated river gravels stranded above the current channel.',
          'Adit / shaft / winze — horizontal / vertical / internal mine openings (all hazards).',
          'Tailings — leftover processed waste rock from past mining.',
          'Gangue — the worthless minerals surrounding the valuable ones.',
        ],
      },
    ],
  },
]

type OpenMenu = 'looking' | 'finds' | 'land' | 'access' | 'guide' | 'app' | null

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const reqSeq = useRef<Record<string, number>>({}) // per-source request counter (race guard)
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
  const [openGuide, setOpenGuide] = useState<string | null>(null) // expanded field-guide entry
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
      nextReq(reqSeq.current, 'mrds') // invalidate any in-flight mrds fetch
      src.setData(EMPTY_FC) // a target with no catalogued mines (e.g. rare earths)
      // Defer (not a synchronous setState in the effect body) to avoid cascading renders.
      queueMicrotask(() => setStatus('No catalogued mines for this target'))
      return
    }
    const seq = nextReq(reqSeq.current, 'mrds')
    fetch(layerUrl('mrds', map, commodity ?? '', depType))
      .then((r) => r.json())
      .then((data: GeoJSON.FeatureCollection) => {
        if (reqSeq.current.mrds !== seq) return // a newer target/filter change won the race
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
          // Don't refetch a hidden viewport layer (toggle() refreshes it on
          // turn-on). mrds is exempt — it's the primary layer, kept fresh here.
          if (id !== 'mrds' && map.getLayoutProperty(id, 'visibility') === 'none') continue
          const seq = nextReq(reqSeq.current, id)
          fetch(layerUrl(id, map, id === 'mrds' ? commodity ?? '' : '', id === 'mrds' ? depType : ''))
            .then((r) => r.json())
            .then((data: GeoJSON.FeatureCollection) => {
              if (reqSeq.current[id] !== seq) return // a newer pan won the race
              src.setData(id === 'aml' ? tagClosure(data) : data)
            })
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
    // React StrictMode (dev) mounts → unmounts → remounts. Without this flag the
    // first map's async load loop keeps running after its map is removed, throwing
    // on the leftover layers and reporting phantom "N layers unavailable".
    let cancelled = false
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
      const failed: string[] = []
      let countiesData: GeoJSON.FeatureCollection | null = null
      for (const { id } of LAYERS) {
        try {
          const res = await fetch(layerUrl(id, map))
          if (!res.ok) throw new Error(`${res.status}`)
          const data = (await res.json()) as GeoJSON.FeatureCollection
          if (cancelled) return // map was torn down mid-load (StrictMode/unmount)
          if (id === 'counties') countiesData = data
          const srcData = id === 'aml' ? tagClosure(data) : data
          map.addSource(`${id}-src`, { type: 'geojson', data: srcData })
          map.addLayer(layerSpec(id))
          loaded += data.features.length
        } catch (err) {
          // One layer failing (e.g. a source not yet ingested) shouldn't blank
          // the whole map — skip it, note it, and keep loading the rest.
          console.error(`layer "${id}" failed to load`, err)
          failed.push(id)
          continue
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
      } else {
        // Zoom-lock is derived from the counties extent; without it the view
        // can't be bounded. Warn rather than fail silently (counties also shows
        // in the unavailable-layers status note below).
        console.warn('counties layer unavailable — map view not bounded (zoom-lock off)')
      }
      if (cancelled) return // don't report status for a torn-down map
      const note = failed.length
        ? ` — ${failed.length} layer(s) unavailable (${failed.join(', ')}); is the API on ${API_BASE}?`
        : ''
      setStatus(`${loaded.toLocaleString()} features loaded${note}`)
      setReady(true)
    })

    map.on('click', (e) => {
      const b = 5
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - b, e.point.y - b],
        [e.point.x + b, e.point.y + b],
      ]
      // Only query layers that actually loaded — a layer can be absent if its
      // source failed to load (see the resilient load loop above).
      const present = LAYERS.map((l) => l.id).filter((id) => map.getLayer(id))
      const feats = map.queryRenderedFeatures(box, { layers: present })
      if (!feats.length) return
      const order = [
        'mrds', 'usmin', 'aml', 'districts', 'claims', 'potential',
        'roads', 'trails', 'streams', 'geology', 'ownership', 'forests', 'counties',
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
      cancelled = true
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
    // The pan handler skips hidden viewport layers, so when one is turned back
    // on, refresh it for the current view (mrds is driven by the target effect).
    if (next && id !== 'mrds' && BBOX_LAYERS.has(id)) {
      const src = map.getSource(`${id}-src`) as maplibregl.GeoJSONSource | undefined
      if (src) {
        const seq = nextReq(reqSeq.current, id)
        fetch(layerUrl(id, map))
          .then((r) => r.json())
          .then((data: GeoJSON.FeatureCollection) => {
            if (reqSeq.current[id] === seq) src.setData(id === 'aml' ? tagClosure(data) : data)
          })
          .catch((err) => console.error(`refresh of "${id}" failed`, err))
      }
    }
  }

  function toggleMenu(name: Exclude<OpenMenu, null>) {
    setOpenMenu((cur) => (cur === name ? null : name))
  }

  const finds = LAYERS.filter((l) => l.group === 'finds')
  const land = LAYERS.filter((l) => l.group === 'land')
  const access = LAYERS.filter((l) => l.group === 'access')

  return (
    <div className="map-root">
      <div ref={containerRef} className="map-canvas" />

      {/* Fixed top bar */}
      <header className="topbar">
        <span className="brand">Prospector's Compass</span>

        {/* 1 — Looking for: the search intent (target selector + gems) */}
        <div className="bar-item">
          <button className="bar-btn primary" onClick={() => toggleMenu('looking')}>
            Looking for ▾
          </button>
          {openMenu === 'looking' && (
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
            </div>
          )}
        </div>

        {/* 2 — Known finds: where minerals are proven/likely */}
        <div className="bar-item">
          <button className="bar-btn" onClick={() => toggleMenu('finds')}>
            Known finds ▾
          </button>
          {openMenu === 'finds' && (
            <div className="dropdown">
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
            </div>
          )}
        </div>

        {/* 3 — Land & claims: can I legally be / dig here */}
        <div className="bar-item">
          <button className="bar-btn" onClick={() => toggleMenu('land')}>
            Land & claims ▾
          </button>
          {openMenu === 'land' && (
            <div className="dropdown">
              {land.map((l) => (
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

        {/* 4 — Access & terrain: getting there + the ground underfoot */}
        <div className="bar-item">
          <button className="bar-btn" onClick={() => toggleMenu('access')}>
            Access & terrain ▾
          </button>
          {openMenu === 'access' && (
            <div className="dropdown">
              {access.map((l) => (
                <label key={l.id} className="layer-toggle">
                  <input type="checkbox" checked={visible[l.id]} onChange={() => toggle(l.id)} />
                  {l.label}
                </label>
              ))}
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

        {/* 5 — Field guide: non-AI beginner prospecting advice (reference zone) */}
        <div className="bar-item">
          <button className="bar-btn" onClick={() => toggleMenu('guide')}>
            📖 Field guide ▾
          </button>
          {openMenu === 'guide' && (
            <div className="dropdown guide">
              {FIELD_GUIDE.map((cat) => (
                <div key={cat.name} className="guide-cat">
                  <div className="guide-cat-label">{cat.name}</div>
                  {cat.entries.map((entry) => (
                    <div key={entry.id} className="guide-entry">
                      <button
                        className="guide-head"
                        onClick={() => setOpenGuide((g) => (g === entry.id ? null : entry.id))}
                      >
                        <span>{entry.title}</span>
                        <span className="guide-caret">{openGuide === entry.id ? '▴' : '▾'}</span>
                      </button>
                      {openGuide === entry.id && (
                        <ul className="guide-body">
                          {entry.body.map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              <p className="guide-foot">
                A non-AI field guide — general advice. Always verify land status, active claims, and
                local rules before you dig.
              </p>
            </div>
          )}
        </div>

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

      {/* Persistent land-status disclaimer whenever ownership or claims is shown */}
      {(visible.ownership || visible.claims) && (
        <div className="disclaimer-chip">
          ⚠ Land status &amp; claims are informational only — verify with the managing agency before digging.
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
        {visible.claims && (
          <div className="legend-row">
            <b>Claims</b>
            <span title="Ground a third party currently holds an active mining claim on">
              <i style={{ background: '#ef4444' }} />active (staked)
            </span>
          </div>
        )}
        {visible.streams && (
          <div className="legend-row">
            <b>Water</b>
            <span><i style={{ background: '#3b82f6' }} />streams &amp; rivers</span>
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

            <h3>The menus</h3>
            <p>
              The top bar groups everything by the question you&rsquo;re asking:
              <b> Looking for</b> (what you&rsquo;re hunting) · <b>Known finds</b> (where minerals
              are proven or likely) · <b>Land &amp; claims</b> (can I legally be / dig here) ·
              <b> Access &amp; terrain</b> (getting there and the ground underfoot).
            </p>

            <h3>What are you looking for?</h3>
            <p>
              Pick a <b>target</b> (in <i>Looking for</i>) and the map focuses on it: the mineral-
              potential layer recolors to that target's favorability, and the known mines filter to it.
              Some targets only have one kind of evidence — e.g. there's no silver <i>potential</i> layer,
              and no catalogued rare-earth <i>mines</i> in the corridor; the map says so when that happens.
              Choose <i>Anything</i> to see all mines, or open <i>All commodities</i> to filter mines by any
              raw commodity.
            </p>

            <h3>Known finds</h3>
            <ul>
              <li><b>Mineral potential (CGS)</b> — favorability rating (low → high amber) for the chosen target.</li>
              <li><b>Historic mining districts</b> — proven-productive metal-mining ground.</li>
              <li><b>MRDS mines</b> — known mineral occurrences. <span className="k cyan" />placer (stream gravels) vs <span className="k amber" />lode (hard rock). <i>Tip: filter to commodity</i> <b>Geothermal</b> <i>to see hot/warm springs.</i></li>
              <li><b>USMIN features</b> — mine features digitized from historic topo maps.</li>
              <li><b>Faults (lode structure)</b> — <span className="k violet" />mapped fault lines. Faults and fractures are the dominant structural control on hard-rock (lode) ore, so veins and deposits cluster along them — a key lode-prospecting indicator.</li>
            </ul>

            <h3>Land &amp; claims</h3>
            <ul>
              <li><b>Land ownership</b> — colored by access-relevance (who manages it). See the disclaimer below.</li>
              <li><b>Active mining claims (BLM)</b> — <span className="k red" />ground a third party has currently staked for mineral rights. Tells you which public land is already spoken for, so you don&rsquo;t prospect a claim that isn&rsquo;t yours. Boundaries are PLSS-approximate — verify via the BLM MLRS link.</li>
              <li><b>National forest boundaries</b> — which named forest you&rsquo;re in (prospecting rules differ per forest).</li>
            </ul>

            <h3>Access &amp; terrain</h3>
            <ul>
              <li><b>Geologic map</b> — bedrock colored by rock type.</li>
              <li><b>County boundaries</b> — boundary context.</li>
              <li><b>Streams &amp; rivers</b> — <span className="k blue" />main perennial creeks, rivers &amp; streams (year-round water — what you need to pan or sluice). Placer gold follows water, so trace a creek downhill from a lode or district.</li>
              <li><b>Roads / trails</b> — public + USFS; primary roads are thicker.</li>
              <li><b>Mine hazards (AML)</b> — abandoned-mine hazards (orange → red by severity). Stay clear.</li>
            </ul>

            <h3>Land status</h3>
            <p>
              The ownership colors group land by whether prospecting is typically allowed — but they are
              <b> informational only</b>. Always verify land status and the local rules with the managing
              agency, and check mining claims via the BLM MLRS link, before digging.
            </p>

            <h3>Where else to look (gems &amp; gold not in the map data)</h3>
            <p>
              Some Colorado gems and gold aren&rsquo;t in the federal/state datasets behind this
              map — e.g. opal near Grand Junction (Grand Mesa basalts) or turquoise near Leadville.
              These authoritative references help fill the gaps:
            </p>
            <ul>
              <li>
                <a href="https://coloradogeologicalsurvey.org/geology/gemstones/" target="_blank" rel="noreferrer">
                  CGS — Colorado gemstones ↗
                </a>
              </li>
              <li>
                <a href="https://pubs.usgs.gov/gip/prospect2/prospectgip.html" target="_blank" rel="noreferrer">
                  USGS — Prospecting for Gold ↗
                </a>
              </li>
              <li>
                <a href="https://pubs.usgs.gov/publication/pp610" target="_blank" rel="noreferrer">
                  USGS Professional Paper 610 — Principal Gold-Producing Districts ↗
                </a>
              </li>
            </ul>

            <h3>Coming soon</h3>
            <p>Settings, profile, and transferring an area to the offline phone app.</p>
          </div>
        </div>
      )}
    </div>
  )
}
