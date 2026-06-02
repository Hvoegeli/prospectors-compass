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

---

## Refresh cadence (Group 2 subtask 7)

- **MRDS / county boundaries:** change slowly (years); re-run on demand.
- **Land status (BLM/USFS — pending):** target monthly refresh per PRD §9.4.
  Each land-status record must carry an "as-of" date stamp.
