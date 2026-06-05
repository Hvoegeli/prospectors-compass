# Detailed Geologic Map Sources — Commercial-Licensing Assessment

Research output (2026-06-04) on geologic maps **more detailed** than the project's
current USGS SGMC (~1:500,000) layer, for the 16-county focus area, evaluated for
**commercial** redistribution (the app is becoming a commercial, offline-bundling
product). See also [CANDIDATE_DATA_SOURCES.md](CANDIDATE_DATA_SOURCES.md) and the
CGS licensing note in [DATA_SOURCES.md](DATA_SOURCES.md).

## Deciding fact

**USGS works are public domain (17 U.S.C. §105) — freely bundlable.** The Colorado
Geological Survey (CGS) is a **state** agency, so its data is **not** automatically
public domain; commercial redistribution must be confirmed per product. Its REST
services portal does state "public domain," but its download packages do not
uniformly state commercial terms.

## Avoid (no detail gain)

- **mrdata.usgs.gov Colorado state geology / USGS OFR 2005-1351** — public domain &
  ingestible, but **1:500,000 (Tweto 1979)** = the same resolution we already have.
  There is **no "HD SGMC."** To beat 1:500k you must use the 1°×2° and quad products.

## Tier 1 — use now (public domain + ingestible + good coverage)

1. **USGS 1°×2° quad geology, 1:250,000** (2× finer than SGMC). Vector GIS via
   **USGS OFR 99-0427** (ARC/INFO e00 → shapefile via GDAL/geopandas) for the
   **Leadville, Montrose, Grand Junction** sheets — covers most western + central
   counties. `https://pubs.usgs.gov/of/1999/ofr-99-0427/`
   - **Denver 1°×2° (I-1163)** for the Front Range counties (Denver, Jefferson,
     Clear Creek, Gilpin, Park). Public domain.
2. **CGS REST services** (`https://gis.colorado.gov/public/rest/services`) — the one
   CGS surface that **explicitly states public domain**; fetchable via the existing
   `arcgis.fetch_features` helper. Cleanest CGS license — prefer this over the zips.

## Tier 2 — use after a per-publication license check (finest detail, STATEMAP)

3. **CGS 30×60 GeMS compilations, 1:100k (1:24k merged)** — Montrose (OF-22-16D),
   Delta (OF-22-13D), Grand Junction (OF-22-14D). Best detail for the western
   counties. GeMS geodatabase + shapefile (geopandas-ready). STATEMAP cooperative →
   strong public-domain argument, but **confirm the specific page's terms before
   bundling**.
4. **CGS & USGS individual 1:24,000 quad maps** over the mining districts
   (Breckenridge OF-02-07, Leadville South OF-12-06, Central City, Aspen). USGS ones
   are clean public domain; CGS ones need the Tier-2 verification.

## Coverage gaps

The CGS 30×60 batch covers the **western** counties (Mesa/Delta/Montrose/Gunnison/
Garfield). For the **Front Range** (Denver/Jefferson/Clear Creek/Gilpin/Park) and
**central mountains** (Lake/Summit/Eagle/Chaffee/Pitkin), lean on the **USGS 1°×2°**
maps (Denver, Leadville sheets) + individual CGS/USGS 1:24k quads.

## Recommended next step (licensing, not coding)

Before bundling any CGS **download package** (Tier 2), confirm the exact use grant
in writing — read the metadata/README inside two representative `.zip`s (e.g.
Montrose OF-22-16D, Breckenridge OF-02-07) or email CGS. The STATEMAP/USGS funding +
the CGS REST "public domain" statement make a strong case, but a commercial product
wants that confirmation **on file per dataset**. Prefer pulling CGS data via the
public-domain REST services where the same layers are available.

## Implementation note

A streams/rivers layer (USGS NHD flowlines, public domain) was identified separately
as the highest-value *prospecting* add (placer gold follows drainages) and mirrors
the roads ingest — independent of this geology-detail question.

_Caveat: WebFetch was unavailable in the research run, so licensing claims (esp. the
CGS "public domain REST services" statement) come from search-result text and should
be confirmed by eye on the CGS GIS portal before committing engineering time._
