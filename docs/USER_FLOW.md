# User Flow — Prospector's Compass

## Primary Flow

### Flow A — Trip Planning (Desktop)

```
┌─────────────────┐
│ Friday evening  │
│ User opens      │  ~0s
│ desktop web app │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────┐
│ Pick state (CO) +           │  ~10s
│ target material(s)          │
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Type query, e.g.            │  ~30s
│ "placer gold within 2hrs    │
│  of Denver, beginner"       │
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Supervisor decomposes →     │  ~5–30s
│ subagents fire in parallel  │
│ → synthesis with citations  │
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Ranked candidate areas      │
│ + interactive map           │
│ + "what to look for" guide  │
│ + hazards + checklist       │
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Pin top candidate, save as  │
│ trip, sync MBTiles to phone │
└─────────────────────────────┘
```

### Flow B — In the Field (Mobile)

```
┌─────────────────┐
│ Saturday        │
│ User arrives    │  (no signal expected)
│ at trailhead    │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────┐
│ Open mobile app — already   │  ~1s
│ cached + offline-ready      │
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ GPS shows current position  │
│ on topo + geology overlay;  │
│ planned waypoints visible   │
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ User finds something        │
│ glittery → snaps photo      │  ~3–5s
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Specimen ID Agent returns:  │
│ - top candidates + conf     │
│ - distinguishing field tests│
│ - "what this means" note    │
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ User logs find with GPS     │
│ + notes → trip log          │
└─────────────────────────────┘
```

### Flow C — Learning (Desktop)

User opens app with no destination → asks open question ("Colorado pegmatite minerals") → Education/Knowledge subagent returns structured primer with linked map regions and recommended public-domain reading → user bookmarks the primer → it seeds a future trip via Flow A.

## API Endpoints

### `POST /auth/magic-link`
**Request:** `{ "email": "user@example.com" }`
**Response:** `204 No Content` (email sent)

### `GET /auth/verify?token=...`
**Response:** `{ "session_token": "..." }` and sets session cookie

### `POST /agent/query`
**Request:**
```json
{
  "trip_id": "uuid|null",
  "state": "CO",
  "targets": ["gold-placer", "gold-lode", "topaz", ...],
  "query": "placer gold within 2 hours of Denver, beginner-friendly"
}
```
**Response:** Server-Sent Events stream:
```
event: subagent_started
data: { "agent": "Geology", "trace_id": "..." }

event: subagent_done
data: { "agent": "Geology", "evidence_count": 4, "confidence": "high" }

event: synthesis
data: {
  "answer": "...",
  "candidates": [
    {"name": "Clear Creek tribs", "rationale": "...", "confidence": "moderate", "geom": {...}},
    ...
  ],
  "map_features": [...],
  "citations": [{"source": "MRDS", "id": "M123456", "url": "..."}],
  "hazards": [{"kind": "abandoned_mine", "geom": {...}, "note": "..."}],
  "land_status_disclaimer": "Verify with the relevant agency..."
}

event: done
```

### `POST /agent/specimen-id`
**Request:** multipart with `image`, `lat`, `lon`
**Response:**
```json
{
  "candidates": [
    {"name": "Pyrite", "confidence": 0.42, "reasoning": "..."},
    {"name": "Native gold", "confidence": 0.18, "reasoning": "..."}
  ],
  "field_tests": ["streak test", "scratch test", "specific gravity"],
  "naming_locked": true,
  "comment": "Confidence below 60% — try the field tests."
}
```

### `GET /trips`
**Response:** `[{id, name, starts_at, ends_at, area_geom_geojson}]`

### `POST /trips`
**Request:** `{ "name": "Clear Creek Sept", "starts_at": "...", "ends_at": "...", "area_geom": { ...geojson... } }`
**Response:** trip detail

### `POST /trips/{id}/finds`
**Request:** multipart with `image`, `lat`, `lon`, `notes`, `specimen_id_result`
**Response:** find detail

### `GET /data/area-export/{trip_id}`
**Response:** `application/zip` containing MBTiles + JSON pre-cached subagent results for offline mobile

## Example Queries

| Query | Expected Result | Expected Answer Skeleton |
|---|---|---|
| "Placer gold within 2 hours of Denver, beginner" | 3–7 areas in Front Range / Clear Creek / Tarryall Creek (Park County) | Idaho Springs / Clear Creek tribs cited from MRDS; technique = panning; hazards = abandoned mines flagged; land-status disclaimer present |
| "Where can I look for topaz in Colorado?" | Lake George / Tarryall Mountains area (Park County, Pikes Peak batholith) | Granite-pocket / pegmatite explanation; Lake George collecting area; CGS citations; "verify access" disclaimer |
| "Photo of yellow metallic flake from creek bed at 39.74N -105.5W" | Specimen ID response | Pyrite (top candidate, ~50%) vs gold (lower); field tests; geology context: known placer drainage |
| "What's the difference between placer and lode deposits?" | Education primer | Glossary entries; map showing nearby placer + lode districts; recommended reading from USGS Circular series |
| "Is it legal to prospect at [coordinates]?" | Refused (out of scope) | "I don't make legality determinations. Land status here is [BLM Royal Gorge Field Office] as of [date]. Verify with the agency: [link to MLRS / BLM contact]." |
| "Recommend an area near a campground I can drive to" | Filter by accessibility + camping | Areas with road access + distance; if lacking campground data, says so honestly |
