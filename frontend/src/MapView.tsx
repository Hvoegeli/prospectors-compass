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

type LayerInfo = { id: string; label: string }

// Draw order: polygons first, then county outlines, then points on top.
const LAYERS: LayerInfo[] = [
  { id: 'geology', label: 'Geology' },
  { id: 'ownership', label: 'Land ownership' },
  { id: 'counties', label: 'Counties' },
  { id: 'usmin', label: 'USMIN features' },
  { id: 'mrds', label: 'MRDS mines' },
]

function layerSpec(id: string): LayerSpecification {
  const source = `${id}-src`
  switch (id) {
    case 'geology':
      return {
        id,
        source,
        type: 'fill',
        paint: { 'fill-color': '#64748b', 'fill-opacity': 0.18, 'fill-outline-color': '#475569' },
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
          'circle-color': '#fbbf24',
          'circle-stroke-color': '#92400e',
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

function popupHtml(layerId: string, props: Record<string, unknown>): string {
  const skip = new Set(['id'])
  const rows = Object.entries(props)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== '')
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
    .join('')
  return `<div class="popup"><h4>${esc(layerId)}</h4><table>${rows}</table></div>`
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [visible, setVisible] = useState<Record<string, boolean>>(
    Object.fromEntries(LAYERS.map((l) => [l.id, true])),
  )
  const [status, setStatus] = useState('Loading layers…')

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
    })

    map.on('click', (e) => {
      const feats = map.queryRenderedFeatures(e.point, { layers: LAYERS.map((l) => l.id) })
      if (!feats.length) return
      new maplibregl.Popup({ maxWidth: '320px' })
        .setLngLat(e.lngLat)
        .setHTML(popupHtml(feats[0].layer.id, feats[0].properties ?? {}))
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
        {LAYERS.map((l) => (
          <label key={l.id} className="layer-toggle">
            <input type="checkbox" checked={visible[l.id]} onChange={() => toggle(l.id)} />
            {l.label}
          </label>
        ))}
        {visible.ownership && (
          <p className="disclaimer">
            Land status is informational only. Verify land status, claim status, and prospecting
            rules with the relevant agency before digging. Mining claims: see the BLM MLRS portal.
          </p>
        )}
      </div>
    </div>
  )
}
