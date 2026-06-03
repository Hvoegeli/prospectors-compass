# Data Sources & Licenses

Every ingested dataset, its source, license, and how it's processed. Required by
Group 2 subtask 8. All data is downloaded **locally** per machine and is never
committed to the repo (see `.gitignore`); this file documents *what the code
downloads*, not bundled data.

All geometries are stored in **SRID 4326 (WGS84)** and clipped to the active
`DownloadRegion` (v1 default: the I-70 corridor, 10 counties — PRD §7.1).

| Dataset | Source | License | Ingested via |
|---|---|---|---|
| County boundaries (clip mask) | US Census Bureau — 2023 Cartographic Boundary Files, county 1:500k | Public domain (US Gov work, 17 U.S.C. §105) | `ingest/census.py` → `counties` |
| Mine / prospect points | USGS Mineral Resources Data System (MRDS) | Public domain (US Gov work, 17 U.S.C. §105) | `ingest/mrds.py` → `mrds_sites` |
| Topo mine features | USGS USMIN — Prospect/Mine-Related Features (per-state) | Public domain (US Gov work, 17 U.S.C. §105) | `ingest/usmin.py` → `usmin_features` |
| Geologic unit polygons | USGS State Geologic Map Compilation (per-state) | Public domain (US Gov work, 17 U.S.C. §105) | `ingest/geology.py` → `geologic_units` |
| Land manager / ownership | USGS PAD-US 4.1 Fee layer (per-state) — **substitutes BLM** (see note) | Public domain (US Gov work, 17 U.S.C. §105) | `ingest/padus.py` → `land_ownership` |
| Roads + 4WD trails (public) | US Census TIGER/Line Roads (per-county) | Public domain (US Gov work, 17 U.S.C. §105) | `ingest/roads.py` → `roads` |
| Forest roads + trails (USFS) | USFS EDW RoadCore_FS + TrailNFS_Publish (national) | Public domain (US Gov work, 17 U.S.C. §105) | `ingest/roads.py` (forest) → `roads` |
| National forest boundaries | USFS EDW Administrative Forest Boundaries (national) | Public domain (US Gov work, 17 U.S.C. §105) | `ingest/usfs_forest.py` → `admin_forests` |
| Historic metal-mining districts | Colorado Geological Survey ON-007-08D (per-state) | Public-use state-gov data (see note) | `ingest/cgs.py` → `mining_districts` |
| Mineral resource potential | Colorado Geological Survey ON-007-03 (ArcGIS MapServer) | Public-use state-gov data (see note) | `ingest/cgs.py` → `mineral_potential` |
| Abandoned mine-land hazards | Colorado Geological Survey ON-008-04 (per-state) | Public-use state-gov data (see note) | `ingest/cgs.py` → `aml_hazards` |

---

## County boundaries (clip mask)

- **URL:** https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip
- **Download size:** ~11.6 MB (national, all US counties).
- **As-of:** 2023 vintage (cartographic boundary release).
- **Why the 500k cartographic file** (not full TIGER): generalized geometry,
  ~10× smaller, precise enough for clipping.
- **Processing:** filter to the region's county GEOIDs, reproject to 4326,
  normalize to MultiPolygon, load into `counties`.

## USGS MRDS (mine / prospect points)

- **URL:** https://mrdata.usgs.gov/mrds/mrds-csv.zip
- **Download size:** ~25.8 MB zip (~137 MB CSV, ~304k national records).
- **As-of:** file dated 2022-08-23 (MRDS is a legacy database; updated rarely).
- **Coverage in focus area:** ~4,400 sites across the 10 I-70 counties.
- **County attribution:** assigned by **spatial join** to our county polygons,
  not from MRDS's own (unreliable) `county` text field.
- **Fields kept:** `dep_id` (PK), `site_name`, `url`, `dev_stat`, `commod1-3`,
  point geometry, plus the joined `county_geoid`.
- **Caveat:** MRDS records vary in quality/precision; treat as historical
  context, not ground truth. Surface its `url` for provenance.

## USGS PAD-US (land manager / ownership)

- **URL:** `https://www.sciencebase.gov/catalog/file/get/6759abcfd34edfeb8710a004?name=PADUS4_1_State_{STATE}_GDB_KMZ.zip` (per-state GeoDatabase)
- **Download size:** ~168 MB (Colorado); a FileGDB, extracted locally.
- **Layer used:** `PADUS4_1Fee_State_{STATE}` (fee ownership/management). Chosen
  over the "Combined" layer: by AREA the Fee layer is dominated by the federal
  lands that matter (Forest Service 14.5M ac, BLM 8.45M ac statewide).
- **Coverage in focus area:** ~1,845 polygons; FS + BLM dominate by area.
- **Source vintage / as-of:** per-record `Src_Date` stored as `as_of_date`
  (PRD §9.4 — every land-status record carries an as-of stamp).
- **CRS:** PAD-US Albers (ESRI:102039) → reprojected to 4326.
- **Geometry repair:** PAD-US has invalid (nested-shell) polygons; `.make_valid()`
  is applied before clipping (see ERROR_FIX_LOG).
- **⚠️ Source substitution:** the spec named "BLM." We use USGS PAD-US instead —
  same manager/owner info, cleaner per-state public-domain form, consistent with
  our USGS pipeline. Surfaced and approved 2026-06-01. BLM remains the source for
  the (separate, pending) mining-claims layer, which PAD-US does not cover.
- **Land-status rule:** informational only — answers must carry the disclaimer
  and never make a go/no-go determination (enforced at the agent layer).

### Mining claims — deferred to portal link (not ingested in v1)

Per PRD Open Question #2, BLM mining-claim data is PLSS-based legal records
(not clean geodata) and notoriously lagging. Decision (2026-06-01): **do not
ingest claims for v1.** Instead, the Land Status agent/UI surfaces a link to
BLM's official **MLRS** portal for claim verification. Revisit if claim
ingestion proves worth the effort later.

## Census TIGER roads + trails (public)

- **URL:** https://www2.census.gov/geo/tiger/TIGER2023/ROADS/tl_2023_{GEOID}_roads.zip (per county)
- **Classes kept** (MTFCC): `S1100` Primary + `S1200` Secondary → `category='road'`;
  `S1500` Vehicular Trail (4WD) → `category='trail'`. City streets (`S1400`) dropped.
- **Coverage in focus area:** ~727 road + ~896 trail segments across the 10 counties.
- **CRS:** TIGER NAD83 (4269) → reprojected to 4326.
## USFS forest roads + trails

- **URLs:** `https://data.fs.usda.gov/geodata/edw/edw_resources/shp/S_USA.RoadCore_FS.zip`
  (~432 MB national) and `…/S_USA.TrailNFS_Publish.zip` (~230 MB national).
- **Read strategy:** national files read with a focus-area **bbox filter** (pyogrio),
  so the whole nation never loads into memory; then clipped to the county union.
- **Coverage in focus area:** ~2,530 forest roads + ~1,945 forest trails (TERRA only).
- **Forest roads** carry `OPER_MAINT` (operational maintenance level) as `road_class`
  — drivability: 5 paved → 3 passenger car → 2 high-clearance/4×4 → 1 closed.
- **Trails** limited to `TRAIL_TYPE = 'TERRA'` (land); snow/water routes excluded.
- **CRS:** USFS NAD83 (4269) → reprojected to 4326. Stored with `kind='forest'`
  in the shared `roads` table alongside the public (TIGER) `kind='public'` rows.

## USGS USMIN (topo mine features)

- **URL:** https://mrdata.usgs.gov/usmin/state/usmin-{STATE}.zip (per-state)
- **Download size:** ~2.4 MB (Colorado).
- **Source vintage:** 2023 compilation (`USGS_TopoMineSymbols` ver 10).
- **Geometry:** point features (also a polygon layer for pit/tailings areas,
  not yet ingested — points only for v1).
- **Coverage in focus area:** ~12,800 features (Prospect Pit, Adit, Mine Shaft,
  Quarry, …) clipped from ~43,300 statewide.
- **County attribution:** spatial join to our county polygons.
- **vs MRDS:** USMIN = symbols digitized from topo maps (where features *are*);
  MRDS = deposit records (commodities, production). Complementary.

## USGS geologic unit polygons (SGMC)

- **URL:** https://mrdata.usgs.gov/geology/state/shp/{STATE}.zip (per-state, e.g. `CO.zip`)
- **Download size:** ~8.1 MB (Colorado).
- **Source vintage:** file dated 2022-01-12; compiled from older state maps
  (each polygon carries `SRC_URL`/`REF_ID` to its source publication).
- **Coverage in focus area:** ~1,700 unit polygons (clipped from ~7,300 statewide).
- **Enrichment:** polygons joined to the package's `*_units.csv` on `unit_link`
  for unit name, age, lithology (`rocktype1-3`), and description.
- **Clip:** intersected against the *dissolved union* of the region's counties
  (a unit spans many counties, so it's a coverage layer with no single county).
- **Note:** per-state download honors "localized downloads" — only the chosen
  state is fetched, not the ~1 GB national SGMC geodatabase.

## USFS Administrative Forest boundaries

- **URL:** https://data.fs.usda.gov/geodata/edw/edw_resources/shp/S_USA.AdministrativeForest.zip
- **Download size:** ~43 MB (national shapefile).
- **What it is:** the *proclaimed* national-forest envelopes (e.g. "White River
  National Forest") — broader than the FS-managed parcels in `land_ownership`
  (PAD-US), because the envelope includes private inholdings. Kept because
  prospecting / recreational-mining rules differ **per forest**, so the Land
  Status agent needs the named forest to cite the right rules.
- **Read strategy:** national file read with a focus-area **bbox filter**
  (pyogrio), then clipped to the county union.
- **Coverage in focus area:** 6 forests (White River, Arapaho & Roosevelt, Pike
  & San Isabel, Grand Mesa-Uncompahgre-Gunnison, Medicine Bow-Routt, plus
  Manti-La Sal clipping into far-western Mesa County).
- **CRS:** USFS NAD83 (4269) → reprojected to 4326.

## CGS Historic Metal Mining Districts (ON-007-08D)

- **URL:** https://coloradogeologicalsurvey.org/Docs/Pubs/ON-007-08D-v20201112.zip
- **Download size:** ~193 MB zip (mostly bundled county-report PDFs; the
  shapefile itself is ~2.4 MB).
- **Shapefile:** `Colorado_Historic_Metal_Mining_Districts.shp` (383 statewide
  polygons; ~157 clipped to the focus area).
- **What it is:** named historic metal-mining districts — proven-productive
  ground for gold/silver. The single highest-signal prospecting layer.
- **Fields kept:** `District` (name), `County_1/2`, `WebPage` (link to the CGS
  county review PDF — surfaced for provenance), `Source`, `Note`.
- **Source vintage:** v20201112 (Burnell, J.R., 2015, ON-007-08).
- **CRS:** NAD83 UTM 13N (26913) → reprojected to 4326.

## CGS Mineral Resource Potential Derivative Map (ON-007-03)

- **Service:** `https://cgsarcimage.mines.edu/arcgis/rest/services/cgs_services/Mineral_Resource_Potential_Derivative_Map/MapServer/10`
- **Access:** CGS offers no static download for this product — only an ArcGIS
  web viewer. We query the backing **ArcGIS MapServer** (it has Query + geoJSON
  enabled), bbox-filtered to the focus area and **paginated** (1000/page).
- **⚠️ Pagination gotcha:** `resultOffset` paging is only stable with an explicit
  `orderByFields` — without it the server reorders rows between pages, producing
  duplicates and omissions. We pin `orderByFields=OBJECTID` (see ERROR_FIX_LOG).
- **Model:** one polygon coverage (geologic units), each rating commodities 1
  (low) / 2 (moderate) / 3 (high). The 22 web-map "sublayers" are just the same
  polygons symbolized by different columns — so we pull once.
- **Columns kept:** only prospecting-relevant targets — `MET_Au_P` (placer gold),
  `IM_PEGM` (pegmatite → beryl/aquamarine/topaz), `IM_CRDM` (corundum →
  ruby/sapphire), `MET_REE` (rare earth), `IM_FLUO` (fluorite). We keep only
  polygons where one of these rates > 0 (the industrial/aggregate/coal commodities
  are not prospecting targets).
- **Coverage in focus area:** ~7,378 polygons (clipped from ~22,700 in-bbox).
- **CRS:** requested back as 4326 via `outSR` (source is NAD27 UTM 13N, 26713).

## CGS Abandoned Mine Land Inventory (ON-008-04)

- **URL:** https://coloradogeologicalsurvey.org/wp-content/uploads/2025/07/ON-008-04.zip
- **Download size:** ~11.5 MB (FileGDB, `USFS AMLI.gdb`, read in-place via /vsizip).
- **Layers ingested (physical hazards only):** `Hole_Mine_Openings_Final`
  (`hazard_kind='opening'` — adits/shafts you can fall into) and
  `PILE_Mine_Tailings_Final` (`hazard_kind='tailings'` — waste/dump piles). The
  water-sample/test and inventory-area-summary layers are **not** ingested
  (environmental-monitoring points, not actionable physical hazards).
- **Fields kept:** `feature_type` (HTYPE/PTYPE), `haz_rating` (e.g. "extreme
  danger", "potential danger", "no significant hazard"), `env_rating`, `comments`.
- **Coverage in focus area:** ~4,852 hazard points (3,034 openings + 1,818 tailings).
- **Why it matters:** directly serves the PRD requirement to surface hazards when
  abandoned mines are near a recommendation.
- **Source vintage:** collected 1990s, finalized 2011, clerical updates 2020.
- **CRS:** NAD83 UTM 13N (26913) → reprojected to 4326.

> **CGS licensing note:** Colorado Geological Survey publishes these datasets for
> public use via its GIS Data & Web Map Portal. They are state-government works
> (not federal public-domain), distributed for public reuse with source
> attribution; we cite ON-007-08, ON-007-03, and ON-008-04 respectively. If any
> redistribution restriction surfaces, revisit before bundling data (we never
> commit the data itself — only the code that downloads it locally).

---

## Refresh cadence (Group 2 subtask 7)

Run `uv run python -m prospector.ingest refresh` for a full, forced re-download +
re-ingest of every source (sets `PROSPECTOR_FORCE_DOWNLOAD=1`, then runs `all`,
then stamps `data/processed/last_refresh.txt`). Manual cadence:

- **MRDS / county boundaries / geology:** change slowly (years); re-run on demand.
- **Land status (PAD-US ownership):** target monthly refresh per PRD §9.4.
  Each land-status record carries an "as-of" date stamp (`as_of_date`).
- **CGS layers:** updated rarely (per-publication version); re-run on demand.
- **USFS roads/forests:** large national files (~700 MB total) — a full `refresh`
  re-pulls them, so run it when you actually want fresh upstream data.
