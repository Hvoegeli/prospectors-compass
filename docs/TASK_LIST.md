# Task List — Prospector's Compass

## Phase 1: MVP — Foundations + Research Surface

### 1. Project setup
**Satisfies:** infrastructure
- [x] Initialize git repo at project root
- [x] Set up Python backend project (FastAPI + LangGraph + uv or poetry)
- [x] Set up React + TypeScript + Vite frontend
- [ ] Set up local PostgreSQL with PostGIS + pgvector extensions
- [x] Wire `.env` loading and Anthropic API key
- [ ] Configure prompt caching in Anthropic SDK calls (system prompts + tool defs)
- [ ] Add LangSmith tracing init
- [ ] Set Anthropic console budget alerts at $5 (soft) and $8 (hard)

### 2. Data ingestion (CO + TX)  [MVP4]
- [ ] Ingest USGS national geologic map DB for CO and TX
- [ ] Ingest USGS MRDS records for CO and TX
- [ ] Ingest USGS USMIN records for CO and TX
- [ ] Ingest BLM land boundaries + claim layer (with as-of date stamp on every record)
- [ ] Ingest USFS forest boundaries
- [ ] Ingest Colorado Geological Survey publications metadata + key spatial datasets
- [ ] Ingest Texas Bureau of Economic Geology atlas + mineral resources data
- [ ] Build a refresh script (manual run; monthly cadence target for land status)
- [ ] Document license + source for every ingested dataset

### 3. Spatial query tools  [MVP5]
- [ ] Watershed delineation (PostGIS + DEM)
- [ ] Buffer + intersection helpers
- [ ] Distance-from-road / accessibility scoring
- [ ] Slope and aspect analysis
- [ ] Unit tests for each spatial function

### 4. LangGraph supervisor + subagents  [MVP3]
- [ ] Define `StateGraph` with supervisor + 7 subagent nodes
- [ ] Define subagent response contract (`answer`, `evidence[]`, `confidence_tag`, `map_features[]`, `reasoning_chain`) as Pydantic model
- [ ] Implement Geology subagent
- [ ] Implement Maps/GIS subagent
- [ ] Implement Mining History subagent
- [ ] Implement Land Status subagent (always emits disclaimer)
- [ ] Implement Field Guidance subagent
- [ ] Implement Education/Knowledge subagent
- [ ] Wire prompt caching for system prompts and tool definitions
- [ ] `LLM_MOCK_MODE=true` path returns canned subagent responses for dev iteration

### 5. Verification & citation enforcement  [MVP7]
- [ ] Supervisor "no claim without citation" pass before responding
- [ ] Conflict detection between subagents
- [ ] Reasoning-chain rendering in synthesized response
- [ ] Hazard surfacing required when abandoned mines or terrain risks are present in recommendation

### 6. Knowledge corpus + pgvector  [MVP10]
- [ ] Curate public-domain document list (USGS pubs, CGS, TX BEG, USFS/BLM info)
- [ ] Document-licensing review log (track license per source)
- [ ] Ingest + chunk + embed
- [ ] Retrieval helper for the Education and Field Guidance subagents

### 7. Recommendation engine  [MVP6][MVP1][MVP2]
- [ ] Region/state selector UI (CO, TX)
- [ ] Target-material selector UI
- [ ] Supervisor query that returns ranked candidate areas
- [ ] Rationale + confidence band rendering in UI
- [ ] "Pin top candidate" + save-area flow

### 8. Desktop map  [MVP9]
- [ ] MapLibre GL JS canvas with multi-panel layout (map + chat + inspector)
- [ ] Self-hosted TileServer GL serving USGS topo + DEM hillshade + state geo rasters
- [ ] Overlay layers: geology, mines (MRDS/USMIN), land status, drainage, user pins
- [ ] Click-to-inspect feature popups with source attribution
- [ ] Land-status disclaimer always visible when land-status layer is on

### 9. Trip planning (desktop)  [MVP14]
- [ ] Trip model (date range + area + waypoints + finds + chat history)
- [ ] Save area to trip
- [ ] Define waypoints on the map
- [ ] Trip detail view

### 10. Account + auth  [MVP14]
- [ ] Magic-link email auth (passwordless, single-use tokens)
- [ ] Session token signing + verification
- [ ] Single user identity used by both desktop and mobile

### 11. Eval suite (initial)  [MVP15]
- [ ] `evals/cases/` folder structure
- [ ] 10 golden cases for Colorado, 10 for Texas
- [ ] Snapshot replay runner
- [ ] Manual run script (`evals/run.py`)
- [ ] Failed responses easy to add as new eval cases

### 12. Observability  [MVP15][MVP16]
- [ ] LangSmith free-tier integration confirmed working (traces visible)
- [ ] Trace tagging by query type (recommendation / specimen-id / education)
- [ ] Per-run cost log (tokens + dollars)
- [ ] Confirm prompt cache hit rate ≥ 50% on first 20 real queries

## Phase 2: Polish — iOS Mobile Field App

### 13. iOS mobile shell  [MVP11]
- [ ] React Native + Expo project setup (dev build, not Expo Go)
- [ ] Shared TypeScript types between desktop and mobile
- [ ] Backend API client
- [ ] Magic-link auth flow on mobile (deep link from email)

### 14. Offline maps  [MVP11]
- [ ] MBTiles bundling for cached areas
- [ ] MapLibre Native rendering offline
- [ ] Sync flow: download area on desktop → bundle into mobile cache via `/data/area-export`

### 15. GPS + waypoints + find-pins  [MVP12]
- [ ] GPS tracking with battery-conservative defaults (Balanced/Low while idle)
- [ ] Waypoint navigation from trip plan
- [ ] Find logging with coordinates + photo + notes
- [ ] Append-only sync to backend when signal returns

### 16. In-field agent chat  [MVP3]
- [ ] Chat surface as mobile primary view
- [ ] Photo attachment flow (specimen ID)
- [ ] Offline queue for chat when no signal; flushes on reconnect

### 17. Trip sync  [MVP14]
- [ ] Desktop → mobile area sync (offline cache)
- [ ] Mobile → desktop trip log sync (last-write-wins on metadata, append-only finds/waypoints)

## Phase 3: Final — Specimen ID + Eval Gate + Submission

### 18. Specimen ID subagent  [MVP13]
- [ ] Claude Haiku 4.5 vision wiring
- [ ] GPS-conditioned plausibility filter from Geology subagent
- [ ] Confidence band always rendered
- [ ] <60% confidence → structurally locked into "field tests" mode (cannot name specimen)
- [ ] Integration into mobile camera flow

### 19. Specimen ID eval set
- [ ] Assemble 50–100 known-label specimen photos (own + open data like Mindat)
- [ ] Top-1 accuracy harness
- [ ] Calibration check ("high confidence" → correct ≥ 90%)
- [ ] Decide: stick with prompted vision OR add RAG reference-image retrieval

### 20. Final eval pass + cost audit
- [ ] Run full golden eval suite, fix regressions
- [ ] Confirm total spend < $10 hard cap
- [ ] Confirm prompt cache hit rate ≥ 50%
- [ ] Document any open questions in `docs/MEMO.md`

### 21. Submission readiness
- [ ] All [MVPx] requirements ✓
- [ ] README with setup instructions
- [ ] Smoke test desktop + mobile end-to-end (Flow A and Flow B from `docs/USER_FLOW.md`)
- [ ] Land-status disclaimer audit: every panel that shows land status carries it
