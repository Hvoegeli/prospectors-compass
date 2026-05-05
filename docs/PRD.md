# PRD — Prospector's Compass

_Source: `prospectors_compass_prd.md` v0.1 (2026-05-05) + `presearch.md`_

## Overview

Hobbyist app that helps recreational prospectors and rockhounds find promising places to look for gold, silver, copper, platinum, gemstones, and rare specimens in the US. Combines USGS / state-survey / BLM / USFS data with a multi-agent AI system. Two surfaces: desktop web (research, trip planning) and iOS mobile (field, GPS, offline, photo specimen ID).

## Problem Statement

Hobbyist prospectors today face a fragmented information landscape: USGS, state geological surveys, BLM, USFS, and historical mining records each live in different portals with different formats. Synthesizing geology, historical activity, land access, and field technique to answer "where should I prospect this weekend?" requires expertise most hobbyists don't have. In the field, weak cell coverage, no easy specimen ID, and no quick check on whether ground is geologically promising compound the gap. Prospector's Compass closes that gap with a research surface at home and a field companion that works offline.

## Target Users

- **Pete (primary):** ~45, weekend prospector, casual experience (a half-dozen pans), plans trips within a 3-hour radius. Comfortable with phone + laptop, not technical with GIS.
- **Carla (secondary):** newcomer, fascinated post-trip, needs the app to teach her, values explainability — wants to know *why* an area is recommended.
- **Hank (tertiary):** veteran rockhound, wants lesser-known ground and unusual targets, will dig into raw data when the app surfaces it well, heavy mobile/offline user.

## MVP Requirements

- [MVP1] Multi-state region selector (Colorado and Texas only at launch)
- [MVP2] Target material selection (gold placer/lode, silver, copper, platinum, gemstones, collector specimens)
- [MVP3] LangGraph supervisor + 7-subagent topology (Geology, Maps/GIS, Mining History, Land Status, Field Guidance, Specimen ID, Education/Knowledge); subagents communicate only through supervisor
- [MVP4] Local data ingestion: USGS national geologic map DB, MRDS, USMIN, BLM/USFS boundaries + claim layer, CGS, TX BEG into PostGIS
- [MVP5] Spatial query tools (PostGIS): intersection, buffer, watershed delineation, distance-from-road, slope/aspect
- [MVP6] Recommendation engine: ranked candidate areas with plain-language rationale + confidence band
- [MVP7] Verification policy enforcement: citations on every concrete claim, conflict surfacing with full reasoning chains, hazard details surfaced inline
- [MVP8] Land-status surfacing: BLM/USFS boundaries with permanent disclaimer + MLRS link-out for claim verification (never go/no-go)
- [MVP9] Interactive desktop map: MapLibre GL JS + self-hosted MBTiles + toggleable overlay layers (geology, topo, mines, land status, drainage, user pins)
- [MVP10] Public-domain knowledge corpus + pgvector retrieval (USGS pubs, CGS, TX BEG, USFS/BLM info pubs)
- [MVP11] iOS mobile app (React Native + Expo) with offline map cache via bundled MBTiles
- [MVP12] GPS tracking + waypoints + find-pins on mobile (append-only sync to backend)
- [MVP13] Specimen ID: Claude Haiku 4.5 vision with GPS-conditioned candidate list from Geology subagent; <60% confidence locks into "field tests" mode
- [MVP14] Trip log + cross-surface sync (last-write-wins on metadata; finds + waypoints append-only)
- [MVP15] Eval suite: golden snapshot replay, ~10–20 cases per state, run manually pre-merge; LangSmith trace integration
- [MVP16] Cost guardrails: Haiku 4.5 default, Sonnet 4.6 escape hatch only, prompt caching mandatory, $5 / $8 hard alerts

## Final Submission Features (Phase 4 / stretch)

- Additional state expansions (CA, NV, AZ, ID, MT, NM, UT, OR, WA, AK)
- Knowledge corpus expansion (more state surveys, more open-access publications)
- Voice interface for hands-free field queries
- Optional anonymous aggregation ("most-prospected areas this season")
- Android port (currently iOS only)
- Specimen ID accuracy improvements: RAG over reference image bank if prompted vision plateaus
- Active claim-layer auto-refresh automation
- Native Swift rewrite of mobile (only if React Native proves insufficient for camera/GPS/offline performance)

## Performance Targets

| Metric | Target |
|---|---|
| Full multi-subagent recommendation latency | < 30s end-to-end |
| Specimen ID latency (mobile) | < 5s |
| Mobile offline reliability | ≥ 95% of cached-area sessions without crash or data loss |
| Specimen ID top-1 accuracy (common specimens) | ≥ 80% |
| Specimen ID confidence calibration | "high" → correct ≥ 90% of time |
| Recommendation usefulness (in-app feedback) | ≥ 70% thumbs-up |
| Cost ceiling (build + initial deploy) | $10 hard cap |
| Prompt cache hit rate | ≥ 50% on supervisor + subagent system prompts |

## Scope Boundaries

**In scope (v1):**
- Trip planning research surface (desktop web)
- Field navigation + specimen ID (iOS mobile)
- Self-paced learning content
- Land-status surfacing as research aid (informational only, never go/no-go)
- Single-user account with desktop/mobile sync
- Colorado + Texas data only

**Out of scope (v1):**
- Legal-compliance certification ("can I prospect here?")
- Mining claim management or filing
- Marketplace, social network, or sharing surface
- Commercial-grade GIS (not replacing ArcGIS)
- Assay services, lab integrations, specimen valuation
- Android (deferred until post-v1)
- Multi-user concurrency
- States other than CO and TX (Phase 4)
- Voice interface (deferred)
