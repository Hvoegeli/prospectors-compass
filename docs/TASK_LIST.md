# Task List — Prospector's Compass

> **Status audit (2026-07-26):** v1 is feature-complete on desktop + mobile. Checkboxes
> below were reconciled against the actual code on this date — several core items
> (engine, verification, contours, trips, and the entire mobile Phase 2) were already
> shipped but still showed unchecked. Items struck through / marked DEFERRED are out of
> v1 **by design** (offline-first, no cloud AI) — see `CLAUDE.md`. As of this audit the
> engine, verification, contours, trips, the whole mobile app, the test suite (82 passing,
> incl. end-to-end scoring fixtures §11), and the Flow A/B smoke test (§21) are all done.
> Remaining: document open questions in `docs/MEMO.md` (§20) and a clean-second-Mac test
> of the packaged `.dmg`.

## Phase 1: MVP — Foundations + Research Surface

### 1. Project setup
**Satisfies:** infrastructure
- [x] Initialize git repo at project root
- [x] Set up Python backend project (FastAPI + LangGraph + uv or poetry)
- [x] Set up React + TypeScript + Vite frontend
- [x] Set up local PostgreSQL with PostGIS + pgvector extensions
- [x] Wire `.env` loading and Anthropic API key
- [x] Configure prompt caching in Anthropic SDK calls (system prompts + tool defs)
- [x] Add LangSmith tracing init
- [ ] ~~Set Anthropic console budget alerts at $5 (soft) and $8 (hard)~~ → **N/A in v1** (offline, no LLM/API cost). Reinstate if the optional AI layer is added.

### 2. Data ingestion (CO — I-70 corridor focus area)  [MVP4]
_Clip every spatial layer to the 10 focus-area counties (PRD §7.1): Denver, Jefferson, Clear Creek, Gilpin, Park, Summit, Lake, Eagle, Garfield, Mesa. Ingest statewide only where a dataset can't be pre-clipped, then filter on query._
- [x] **Prerequisite — county clip mask:** Census county boundaries → PostGIS `counties` (region-parameterized via `DownloadRegion`)
- [x] Ingest USGS national geologic map DB, clipped to the focus-area counties (1,697 SGMC unit polygons)
- [x] Ingest USGS MRDS records within the focus-area counties (~4,400 sites; spatial-joined to county polygons)
- [x] Ingest USGS USMIN records within the focus-area counties (12,763 topo mine features)
- [x] Ingest BLM land boundaries + claim layer — **ownership done** (1,845 PAD-US polygons w/ as-of date; substitutes BLM, see DATA_SOURCES); **claims deferred to MLRS portal link** (PRD Open-Q #2 — messy PLSS data, low v1 value)
- [x] Ingest USFS forest boundaries within the focus-area counties — Administrative Forest envelopes (6 forests) → `admin_forests` (named-forest context for per-forest prospecting rules; complements PAD-US managed-land parcels)
- [x] Ingest Colorado Geological Survey key spatial datasets for the focus-area counties — Historic Metal Mining Districts (157) → `mining_districts`; Mineral Resource Potential (7,378) → `mineral_potential`; Abandoned Mine Land hazards (4,852) → `aml_hazards`. _(Coal mines skipped — not a prospecting target.)_
- [x] Build a refresh script (manual run; monthly cadence target for land status) — `uv run python -m prospector.ingest refresh` (forces fresh re-download of every source, then stamps `data/processed/last_refresh.txt`)
- [x] Document license + source for every ingested dataset — `docs/DATA_SOURCES.md` (all 11 ingested layers covered, incl. CGS licensing note)
- _Deferred to Phase 4: Texas Bureau of Economic Geology atlas + mineral resources data (revive when Texas re-enters scope)._

### 3. Spatial query tools  [MVP5]
_Framework-agnostic functions in `backend/src/prospector/spatial/` (zero LLM cost); Group 4 wraps them as agent tools._
- [x] Watershed lookup — `spatial/watershed.py` `watershed_at()` via ingested USGS WBD HUC12 polygons. _Deviation from "PostGIS + DEM": uses authoritative pre-delineated WBD subwatersheds (no flow-routing dep); true point-catchment delineation deferred. Surfaced + approved 2026-06-04._
- [x] Buffer + intersection helpers — `spatial/proximity.py` (`features_within`, `point_in`)
- [x] Distance-from-road / accessibility scoring — `spatial/access.py` (`nearest_road`, `accessibility`)
- [x] Slope and aspect analysis — `spatial/terrain.py` (`slope_aspect_at`, `terrain_stats`) sampling `gdaldem`-derived rasters via dockerized `gdallocationinfo`
- [x] Unit tests for each spatial function — `tests/test_spatial_*.py` (13 tests; skip gracefully without data)

### 4. ~~LangGraph supervisor + subagents~~ → DEFERRED (optional future AI)  [MVP3]
_Cut from v1 (offline-first; cloud AI can't run in the field). Preserved as an
optional, online-only future layer — see `CLAUDE.md` "Deferred: optional AI" and
PRD "Final / stretch." The 7 subagent "domains" live on as scoring factors /
report sections in the rule-based engine (Group 7), not as AI agents._

### 5. Verification — factor rationale (folds into Group 7)  [MVP7]
- [x] Every recommendation surfaces the contributing factors that produced its score (each factor = its own evidence; deterministic, no AI) — `engine/scoring.py` `breakdown[]`; rendered in `MapView.tsx` recommend section + the mobile rationale card
- [x] Competing/negative factors shown (e.g. favorable geology BUT steep + far from road) — factors sorted by contribution; access/ownership gates rendered as `×` multipliers on both surfaces
- [x] Hazard surfacing required when abandoned mines or terrain risks are near a recommendation — AML hazard layer; toxic-mineral hazards always surfaced in specimen ID regardless of confidence
- [x] Land-status disclaimer always present — embedded in every `/land-status` response (`api/land_status.py`); rendered on desktop popup + mobile rationale card

### 6. ~~Knowledge corpus + pgvector~~ → DEFERRED (was AI RAG)  [MVP10]
_Replaced in v1 by a curated **static field guide** (mineral/ore properties,
host-rock associations, dichotomous key). pgvector stays installed but unused.
RAG returns only with the optional AI layer._

### 7. Rule-based recommendation engine (the v1 "brain")  [MVP6][MVP1][MVP2]
- [x] Region/state selector — Colorado I-70 corridor focus area (single-region v1; multi-state selector deferred to Phase 4 per MVP1)
- [x] Target-material selector UI (gold placer/lode, silver, gems, …) — `MapView.tsx` "Looking for" dropdown (curated targets + commodity fallback)
- [x] **Weighted-overlay scoring** over the data layers + `spatial/` tools (mineral potential, districts, ownership, accessibility/distance-from-road, slope, watershed, hazards) → ranked candidate areas. Deterministic, offline. — `engine/scoring.py` `score_area()`; three profiles (placer/lode/gem), weights in `docs/ENGINE_WEIGHTS.md`
- [x] Factor-by-factor rationale + confidence band rendering in UI (per Group 5) — desktop + mobile
- [x] "Pin top candidate" + save-area flow — trip system: click → popup → "Add to trip"
- [x] Non-AI field guide / dichotomous key (identification reference) — `frontend/src/identification.ts` + `minerals.json` (kept in sync with mobile via `frontend/scripts/check-identify-sync.mjs`)

### 8. Desktop map  [MVP9]
- [x] MapLibre GL JS canvas with panel layout (map + inspector popups + layer/trip panels). _(No chat panel — the AI chat surface is deferred with the optional-AI layer, not a v1 gap.)_
- [x] Self-hosted TileServer GL serving DEM **hillshade** basemap (`ingest/terrain.py` → `tiles/hillshade.mbtiles`, served on :8080). _USGS topo quads + state geo rasters deferred — hillshade first; contours added (below)._
- [x] Overlay layers: 16 toggleable overlays (`api/layers.py` whitelist) — counties, MRDS, USMIN, geology, ownership, roads, trails, forests, districts, potential, radiometric, AML, claims, streams, faults, contours — plus user pins via the trip system
- [x] Click-to-inspect feature popups with source attribution (multi-layer popups; URL/report fields render as "Open ↗" links)
- [x] Land-status disclaimer always visible when land-status (ownership) layer is on
- [x] bbox-driven loading for the heavy layers (viewport-scoped fetch on pan/zoom)
- [x] **Real elevation contour lines** (toggleable overlay) — `ingest/terrain.py` `build_contours()` runs `gdal_contour` on the 3DEP DEM → `contour_lines` PostGIS table; rendered in `MapView.tsx` as a labeled line layer (200 ft index labels, `CONTOUR_MIN_ZOOM=11`). _Distinct from the hillshade shaded relief. (A live raster-DEM relight basemap was explored and shelved — fake-contour terracing past 30 m native resolution; WIP preserved on branch `feat/terrain-dem-relight`.)_

### 9. Trip planning (desktop)  [MVP14]
- [x] Trip model (name + target + waypoints + finds + notes) — `db/models.py` `Trip` ORM (waypoints in JSONB)
- [x] Save area to trip — "Add to trip" from any feature popup; waypoint snapshots
- [x] Define waypoints on the map — click → popup → add; waypoint kinds/notes
- [x] Trip detail view — Trips panel: active trip name/target/waypoint list, export to phone, import finds

### 10. Account + auth  [MVP14]
- [ ] Magic-link email auth (passwordless, single-use tokens)
- [ ] Session token signing + verification
- [ ] Single user identity used by both desktop and mobile

### 11. Test suite (deterministic)  [MVP15]
- [x] Unit tests for the scoring functions (known inputs → expected ranks/factors) — `tests/test_scoring_radiometric.py` (weights + membership ramps)
- [x] Integration tests over the spatial tools — `tests/test_spatial_*.py`
- [x] Fixture areas with hand-checked expected recommendations — `tests/test_scoring_e2e.py` (data-driven end-to-end: scores the best-rated pegmatite/placer ground over live PostGIS, asserts favorable ground surfaces with rock-favorability leading + the full rationale/gate contract)
- _Golden LLM snapshot replay / LangSmith deferred with the optional AI layer._

### 12. ~~Observability (LangSmith)~~ → DEFERRED with AI  [MVP15][MVP16]
_No LLM tracing in v1 (no AI). Local logging only; reinstate LangSmith + cost/cache
metrics if the optional AI layer is added._

## Phase 2: Polish — iOS Mobile Field App

### 13. iOS mobile shell  [MVP11]
- [x] React Native + Expo project setup (dev build, not Expo Go) — Expo SDK 54 / RN 0.81
- [x] Shared TypeScript types between desktop and mobile — `identification.ts`/`minerals.json` kept in sync by `check-identify-sync.mjs`
- [~] Backend API client — **designed out by offline-first**; the field path has no network. Handoff is via the `.pcbundle`/`.pcfinds` files, not an API.
- [ ] ~~Magic-link auth flow on mobile~~ → **DEFERRED** (no accounts in offline v1; single-user)

### 14. Offline maps  [MVP11]
- [x] MBTiles bundling for cached areas — per-trip `terrain.mbtiles` inside the `.pcbundle`
- [x] MapLibre Native rendering offline — vector topo (`mbtiles://`, bundled glyphs) over raster hillshade, `basemap/topoStyle.ts`
- [x] Sync flow: download area on desktop → bundle into mobile cache — via the desktop "Export to phone" `.pcbundle` (AirDrop/Files), which **replaced** the networked `/data/area-export`

### 15. GPS + waypoints + find-pins  [MVP12]
- [x] GPS tracking with battery-conservative defaults (Balanced/Low while idle) — idle Balanced 25 m/20 s; on-demand High fix with 8 s timeout
- [x] Waypoint navigation from trip plan — waypoints on map + live bearing/distance HUD, tap-to-fly
- [x] Find logging with coordinates + photo + notes — `finds.ts` append-only, crash-safe; photo copied to Documents
- [x] Append-only sync of finds/waypoints back to desktop — `.pcfinds` bundle via share sheet (see §17)

### 16. In-field agent chat  [MVP3]
- [ ] ~~Chat surface / offline chat queue~~ → **DEFERRED with the optional AI layer** (no LLM in offline v1). Specimen ID is handled by the non-AI key (§18), not chat.

### 17. Trip sync  [MVP14]
- [x] Desktop → mobile area sync (offline cache) — `.pcbundle` export/import
- [x] Mobile → desktop trip log sync (append-only finds/waypoints) — `.pcfinds` bundle (finds + dropped pins + notes) AirDropped back; desktop importer handles it

## Phase 3: Final — Specimen ID + Eval Gate + Submission

### 18. Specimen ID — non-AI dichotomous key  [MVP13]
- [x] Property-based key (hardness, streak, luster, color, magnetism, heft, cleavage) → weighted match over 51 minerals — `mobile/src/identification.ts` + `minerals.json`
- [x] GPS/region plausibility hint — trip target tag (e.g. pegmatite) softly biases scoring ×1.15
- [x] Confidence band always rendered; below `NAMING_THRESHOLD = 0.6` → "run these field tests", never names the specimen; toxic-mineral hazards surfaced regardless of confidence
- [x] Works fully offline; integrated into mobile flow (+ "log this as a find"); mirrored on desktop
- _AI/vision photo-ID (cloud or on-device) deferred to the optional AI layer._

### 19. ~~Specimen ID eval set (vision)~~ → DEFERRED with AI vision
_Belongs to the optional AI photo-ID layer; not needed for the non-AI key._

### 20. Final pass + audit
- [x] Run the full (deterministic) test suite, fix regressions — backend `uv run pytest` (82 passed, 2026-07-26)
- [x] Confirm app runs fully offline (no network calls in the field path) — verified by code audit 2026-07-26: desktop field path hits only localhost:8000/8080; mobile has zero network calls
- [ ] Document any open questions in `docs/MEMO.md`

### 21. Submission readiness
- [x] All v1 [MVPx] requirements ✓ (AI/auth/multi-state items deferred by design — see PRD "Final / stretch")
- [x] README with setup instructions — `README.md` (root)
- [x] Smoke test desktop + mobile end-to-end (Flow A and Flow B from `docs/USER_FLOW.md`) — 2026-07-26: Flow A via live API (health, score→high-band pegmatite w/ rationale+gates, land-status disclaimer, layers, trips); Flow B via mobile typecheck + offline fixture + specimen-ID parity. _(Full iOS-simulator GUI run remains a manual step.)_
- [x] Land-status disclaimer audit: every panel that shows land status carries it — verified (desktop popup + mobile rationale card; embedded server-side)
