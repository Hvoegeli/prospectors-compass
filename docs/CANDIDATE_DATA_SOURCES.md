# Candidate Data Sources — Gems & Gold (beyond current ingests)

Research output (2026-06-04, deep-research harness: 5 angles, 20 sources fetched,
84 claims → 24/25 verified). Goal: find sources to fill the gem/gold localities
that the project's current datasets (MRDS, USMIN, SGMC, CGS potential/districts/AML,
PAD-US, 3DEP, WBD, TIGER) underweight — opal, turquoise, topaz, aquamarine/beryl,
lapis, garnet, amazonite, and additional placer/lode gold.

## Decision context

**The app will become commercial** once the owner is satisfied (not commercial
yet). Therefore **all data-source licensing is evaluated as commercial use** — only
public-domain or commercially-licensable data may be bundled/redistributed.

## Shortlist

| Source | Fills | Ingestible? | Format / API | License | Verdict |
|---|---|---|---|---|---|
| **mindat.org** | all target gems + CO localities | Yes (REST/JSON API, OpenMindat pkg) | token API, 1k req/hr | **CC BY-NC-SA, non-commercial, no redistribution** | ❌ **RULED OUT** — commercial blocker |
| **BLM Mining Claims MapServer** | active mining claims | **Yes — ArcGIS REST** (use existing `arcgis.fetch_features`) | ArcGIS MapServer | Public domain (US gov) | ✅ **Best ingestion candidate** |
| **USGS Professional Paper 610** | placer + lode gold districts (incl. Fairplay/Breckenridge) | No — PDF only (1968) | PDF | Public domain | 🟡 Bundleable but needs manual digitization |
| **CGS — Colorado gemstones** | CO gem reference (opal, etc.) | No — reference | web page | © CGS (link only) | 🔗 Reference link (added to Help manual) |
| **USGS — Prospecting for Gold** | central-CO placer gold context | No — reference | web page | Public domain | 🔗 Reference link (added to Help manual) |
| BLM rockhounding page | — | No CO spatial layer | web page | gov | 🔗 reference only |
| USFS ArcGIS Hub | — | No rockhounding layer found | ArcGIS Hub | gov | 🔗 reference only |
| USGS kimberlite/diamond (State Line) | diamonds | Not in CO mrdata catalog; paywalled pub | DOI/PDF | mixed | 🔗 reference only |
| CGS RS-11 (South Platte pegmatites) | rare-earth (not target gems); Jefferson Co | No | PDF | © CGS | ❌ poor fit |

## Recommended actions

1. **Ingest** the BLM Mining Claims MapServer — public-domain, ArcGIS REST, low
   effort with existing tooling; realizes the "active claims" layer previously
   deferred to a portal link.
2. **Reference links** (done): CGS gemstones + USGS gold pamphlet + PP 610 added to
   the desktop Help manual.
3. **Optional, higher effort:** digitize USGS PP 610 gold districts into a
   structured, public-domain layer.

## Open questions

- Does BLM Colorado publish field-office rockhounding sites (Mount Antero
  aquamarine, Cache Creek gold) or State Line kimberlite localities as downloadable
  shapefiles/GeoJSON anywhere on the BLM Geospatial Hub? (not directly probed)
- GPAA / claim-map commercial datasets and CSM theses: formats/licenses unexamined.

_Full cited report: deep-research run `wf_a718af0f-f9f`._
