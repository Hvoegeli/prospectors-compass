import { useEffect, useRef, useState } from 'react'
import maplibregl, {
  type LayerSpecification,
  type StyleSpecification,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './MapView.css'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'

// I-70 corridor (Denver → Grand Junction).
const CENTER: [number, number] = [-106.4, 39.3]
const ZOOM = 6.6

// Neutral background only — no external basemap tiles (stack locks self-hosted
// MBTiles via TileServer GL, which is a later task). Our layers render on top.
const BASE_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0e1726' } }],
}

type LayerInfo = { id: string; label: string; group: 'overlay' | 'finds' }

// Draw order: fills, then lines (counties/roads/trails), then points on top.
const LAYERS: LayerInfo[] = [
  { id: 'geology', label: 'Geologic map', group: 'overlay' },
  { id: 'ownership', label: 'Land ownership', group: 'overlay' },
  { id: 'counties', label: 'County boundaries', group: 'overlay' },
  { id: 'roads', label: 'Roads (hwy/secondary)', group: 'overlay' },
  { id: 'trails', label: 'Trails (4WD)', group: 'overlay' },
  { id: 'usmin', label: 'USMIN features', group: 'finds' },
  { id: 'mrds', label: 'MRDS mines', group: 'finds' },
]

function layerSpec(id: string): LayerSpecification {
  const source = `${id}-src`
  switch (id) {
    case 'geology':
      return {
        id,
        source,
        type: 'fill',
        paint: {
          // Color by generalized lithology, like a real geologic map.
          'fill-color': [
            'match',
            ['get', 'generalized_lith'],
            'Igneous, intrusive', '#e388a3',
            'Igneous, volcanic', '#d1603d',
            'Metamorphic, undifferentiated', '#9b7cb6',
            'Sedimentary, clastic', '#d9c77e',
            'Sedimentary, carbonate', '#7fb5c9',
            'Sedimentary, undifferentiated', '#c9b97e',
            'Unconsolidated, undifferentiated', '#efe7b0',
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
        paint: {
          'fill-color': [
            'match',
            ['get', 'manager_name'],
            'Bureau of Land Management', '#c79a5b',
            'Forest Service', '#3f8f5f',
            '#94a3b8',
          ],
          'fill-opacity': 0.4,
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
          'line-color': ['match', ['get', 'road_class'], 'Primary', '#f87171', '#fb923c'],
          'line-width': ['match', ['get', 'road_class'], 'Primary', 2.4, 1.4],
        },
      }
    case 'trails':
      return {
        id,
        source,
        type: 'line',
        paint: { 'line-color': '#c4b5fd', 'line-width': 1, 'line-dasharray': [2, 2] },
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
          // Differentiate placer (cyan — stream gravels) from lode/hard-rock (amber).
          'circle-color': ['case', ['==', ['get', 'dep_type'], 'Placer'], '#22d3ee', '#fbbf24'],
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

const LAYER_LABEL: Record<string, string> = Object.fromEntries(
  LAYERS.map((l) => [l.id, l.label]),
)

function featureRows(props: Record<string, unknown>): string {
  const skip = new Set(['id', 'state_fips'])
  return Object.entries(props)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== '')
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
    .join('')
}

// One section per layer present at the click — so a single click shows the
// rock type, land manager, any mine, and the road all at once.
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

function mrdsUrl(commodity: string, depType: string): string {
  const p = new URLSearchParams()
  if (commodity) p.set('commodity', commodity)
  if (depType) p.set('dep_type', depType)
  const qs = p.toString()
  return `${API_BASE}/layers/mrds${qs ? `?${qs}` : ''}`
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [visible, setVisible] = useState<Record<string, boolean>>(
    Object.fromEntries(LAYERS.map((l) => [l.id, true])),
  )
  const [status, setStatus] = useState('Loading layers…')
  const [facets, setFacets] = useState<Facets>({ commodities: [], deposit_types: [] })
  const [commodity, setCommodity] = useState('')
  const [depType, setDepType] = useState('')
  const [ready, setReady] = useState(false)

  // Populate the target dropdowns from the real data.
  useEffect(() => {
    fetch(`${API_BASE}/layers/mrds/facets`)
      .then((r) => r.json())
      .then((f: Facets) => setFacets(f))
      .catch(() => {})
  }, [])

  // Re-query the MRDS layer whenever the target filters change.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const src = map.getSource('mrds-src') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    fetch(mrdsUrl(commodity, depType))
      .then((r) => r.json())
      .then((data: GeoJSON.FeatureCollection) => {
        src.setData(data)
        const filtered = commodity || depType ? ' (filtered)' : ''
        setStatus(`MRDS: ${data.features.length.toLocaleString()} sites${filtered}`)
      })
      .catch(() => {})
  }, [commodity, depType, ready])

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
      for (const { id } of LAYERS) {
        try {
          const res = await fetch(`${API_BASE}/layers/${id}`)
          if (!res.ok) throw new Error(`${res.status}`)
          const data = (await res.json()) as GeoJSON.FeatureCollection
          map.addSource(`${id}-src`, { type: 'geojson', data })
          map.addLayer(layerSpec(id))
          loaded += data.features.length
        } catch (err) {
          setStatus(`Failed to load "${id}": ${String(err)} — is the API on ${API_BASE}?`)
          return
        }
      }
      setStatus(`${loaded.toLocaleString()} features loaded`)
      setReady(true)
    })

    map.on('click', (e) => {
      // Query a small box (not a single pixel) so tiny mine dots are easy to hit.
      const b = 5
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - b, e.point.y - b],
        [e.point.x + b, e.point.y + b],
      ]
      const feats = map.queryRenderedFeatures(box, { layers: LAYERS.map((l) => l.id) })
      if (!feats.length) return
      // Show one section per layer present (rock, land manager, mine, road),
      // ordered most-specific first.
      const order = ['mrds', 'usmin', 'roads', 'trails', 'geology', 'ownership', 'counties']
      const picked = order
        .map((id) => feats.find((f) => f.layer.id === id))
        .filter((f): f is maplibregl.MapGeoJSONFeature => f !== undefined)
      if (!picked.length) return
      new maplibregl.Popup({ maxWidth: '340px' })
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

  return (
    <div className="map-root">
      <div ref={containerRef} className="map-canvas" />
      <div className="panel">
        <h3>Prospector's Compass</h3>
        <p className="status">{status}</p>

        <div className="group">
          <span className="group-title">Overlays</span>
          {LAYERS.filter((l) => l.group === 'overlay').map((l) => (
            <label key={l.id} className="layer-toggle">
              <input type="checkbox" checked={visible[l.id]} onChange={() => toggle(l.id)} />
              {l.label}
            </label>
          ))}
          {visible.ownership && (
            <p className="disclaimer">
              Land status is informational only. Verify land status and prospecting rules with the
              relevant agency before digging.
            </p>
          )}
          <a className="claims-link" href="https://mlrs.blm.gov/" target="_blank" rel="noreferrer">
            ⛏ Verify mining claims — BLM MLRS ↗
          </a>
        </div>

        <div className="group">
          <span className="group-title">Finds / targets</span>
          {LAYERS.filter((l) => l.group === 'finds').map((l) => (
            <label key={l.id} className="layer-toggle">
              <input type="checkbox" checked={visible[l.id]} onChange={() => toggle(l.id)} />
              {l.label}
            </label>
          ))}
          {visible.mrds && (
            <div className="legend">
              <span><i className="dot" style={{ background: '#fbbf24' }} /> Lode / hard-rock</span>
              <span><i className="dot" style={{ background: '#22d3ee' }} /> Placer</span>
            </div>
          )}
          <label className="field">
            Commodity
            <select value={commodity} onChange={(e) => setCommodity(e.target.value)}>
              <option value="">Any</option>
              {facets.commodities.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Deposit type
            <select value={depType} onChange={(e) => setDepType(e.target.value)}>
              <option value="">Any</option>
              {facets.deposit_types.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  )
}
