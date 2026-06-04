# PRD — Prospector's Compass

_Source: `prospectors_compass_prd.md` v0.1 (2026-05-05) + `presearch.md`_

> **Direction update (2026-06-04): offline-first, no cloud AI in v1.** This is a
> personal backcountry tool; the field use case has no cell service, so v1 must
> work fully offline. The original multi-agent **cloud-AI** design (MVP3, MVP10,
> MVP13 vision, MVP15/16) is **deferred to a future optional layer** — see
> "Final / stretch." In v1 the "brain" is a **deterministic rule-based
> recommendation engine** and identification is a **non-AI field guide /
> dichotomous key**. Items below are annotated where this changes them.

## Overview

Hobbyist app that helps recreational prospectors and rockhounds find promising places to look for gold, silver, copper, platinum, gemstones, and rare specimens in the US. Combines USGS / state-survey / BLM / USFS data with a **deterministic, rule-based recommendation engine that runs fully offline** (AI is a deferred future option, never required in the field). Two surfaces: desktop web (research, trip planning) and iOS mobile (field, GPS, offline).

## Problem Statement

Hobbyist prospectors today face a fragmented information landscape: USGS, state geological surveys, BLM, USFS, and historical mining records each live in different portals with different formats. Synthesizing geology, historical activity, land access, and field technique to answer "where should I prospect this weekend?" requires expertise most hobbyists don't have. In the field, weak cell coverage, no easy specimen ID, and no quick check on whether ground is geologically promising compound the gap. Prospector's Compass closes that gap with a research surface at home and a field companion that works offline.

## Target Users

- **Pete (primary):** ~45, weekend prospector, casual experience (a half-dozen pans), plans trips within a 3-hour radius. Comfortable with phone + laptop, not technical with GIS.
- **Carla (secondary):** newcomer, fascinated post-trip, needs the app to teach her, values explainability — wants to know *why* an area is recommended.
- **Hank (tertiary):** veteran rockhound, wants lesser-known ground and unusual targets, will dig into raw data when the app surfaces it well, heavy mobile/offline user.

## MVP Requirements

- [MVP1] Multi-state region selector (Colorado only at launch, limited to the I-70 corridor focus area — see §7.1; Texas deferred to Phase 4)
- [MVP2] Target material selection (gold placer/lode, silver, copper, platinum, gemstones, collector specimens)
- [MVP3] ~~LangGraph supervisor + 7-subagent topology~~ → **DEFERRED (optional future AI).** v1 has no cloud agents; the rule-based engine (MVP6) is the brain. The 7 "domains" (geology, maps/GIS, mining history, land status, field guidance, specimen ID, education) survive as *factors/sections*, not AI agents.
- [MVP4] Local data ingestion: USGS national geologic map DB, MRDS, USMIN, BLM/USFS boundaries + claim layer, CGS into PostGIS ✅ done
- [MVP5] Spatial query tools (PostGIS): intersection, buffer, **watershed lookup (USGS WBD)**, distance-from-road, slope/aspect ✅ done
- [MVP6] **Rule-based recommendation engine:** ranked candidate areas via weighted-overlay scoring over the data layers + spatial tools, with a deterministic factor-by-factor rationale + confidence band. Runs fully offline. _(This is now the centerpiece "brain.")_
- [MVP7] Verification policy: **every recommendation surfaces the contributing factors that produced its score** (each factor is its own evidence — deterministic, not AI). Hazards surfaced inline. Conflicts shown as competing factors.
- [MVP8] Land-status surfacing: BLM/USFS boundaries with permanent disclaimer + MLRS link-out for claim verification (never go/no-go)
- [MVP9] Interactive desktop map: MapLibre GL JS + self-hosted MBTiles + toggleable overlay layers (geology, topo, mines, land status, drainage, user pins) ✅ largely done
- [MVP10] ~~Public-domain knowledge corpus + pgvector retrieval~~ → **DEFERRED (was for AI RAG).** Replaced in v1 by a curated **static field guide** (mineral/ore properties, host-rock associations).
- [MVP11] iOS mobile app (React Native + Expo) with offline map cache via bundled MBTiles
- [MVP12] GPS tracking + waypoints + find-pins on mobile (append-only sync to backend)
- [MVP13] Specimen ID → **v1: non-AI dichotomous key** (property-based yes/no flow); below-confidence outcomes give field-test guidance rather than a name. _(AI/vision photo-ID deferred to the optional future layer; would need on-device models to work offline.)_
- [MVP14] Trip log + cross-surface sync (last-write-wins on metadata; finds + waypoints append-only)
- [MVP15] Test suite: **unit/integration tests of the deterministic scoring + spatial logic** (no LLM eval/replay in v1; LangSmith deferred with AI)
- [MVP16] ~~LLM cost guardrails~~ → **N/A in v1** (offline, no per-use API cost). Reinstate if optional AI is added.

## Final Submission Features (Phase 4 / stretch)

- **Optional AI layer (future possibility, explicitly preserved).** An *online-only,
  optional* enrichment used at the research desk (home/trailhead with signal), never
  required for offline field use. Likely first uses: conversational Q&A / plain-English
  explanation of the rule-based recommendations; specimen photo-ID (cloud, or an
  on-device model for offline). Prior design (LangGraph supervisor + Claude subagents,
  pgvector retrieval, LangSmith, budget discipline) is retained as the starting point —
  see `CLAUDE.md` "Deferred: optional AI".
- Statewide Colorado expansion beyond the I-70 corridor focus area (rest-of-CO counties)
- Additional state expansions (Texas first, then CA, NV, AZ, ID, MT, NM, UT, OR, WA, AK) — includes TX BEG atlas + mineral resources data and TX BEG open-access publications, deferred from v1
- Knowledge corpus expansion (more state surveys, more open-access publications)
- Voice interface for hands-free field queries
- Optional anonymous aggregation ("most-prospected areas this season")
- Android port (currently iOS only)
- Specimen ID accuracy improvements: RAG over reference image bank if prompted vision plateaus
- Active claim-layer auto-refresh automation
- Native Swift rewrite of mobile (only if React Native proves insufficient for camera/GPS/offline performance)

## Performance Targets

_(v1 targets; AI-specific metrics moved to the deferred AI layer.)_

| Metric | Target |
|---|---|
| Recommendation latency (local, rule-based) | < 2s end-to-end |
| Mobile offline reliability | ≥ 95% of cached-area sessions without crash or data loss |
| Recommendation usefulness (in-app feedback) | ≥ 70% thumbs-up |
| Cost to run (v1) | $0 (fully offline, no per-use API) |

_Deferred with the optional AI layer: subagent latency, specimen-ID vision latency/accuracy/calibration, prompt-cache hit rate, LLM cost ceiling._

## Scope Boundaries

**In scope (v1):**
- Trip planning research surface (desktop web)
- Field navigation + **non-AI** specimen ID / field guide (iOS mobile)
- Self-paced learning content
- Land-status surfacing as research aid (informational only, never go/no-go)
- Single-user account with desktop/mobile sync
- Colorado data only, limited to the **I-70 corridor focus area** — 10 counties: Denver, Jefferson, Clear Creek, Gilpin, Park, Summit, Lake, Eagle, Garfield, Mesa (Denver metro + the I-70 corridor to Grand Junction, covering the core of the Colorado Mineral Belt). This is the canonical focus-area county list referenced elsewhere as "the I-70 corridor focus area."

**Out of scope (v1):**
- Cloud AI / multi-agent system (deferred to an optional, online-only future layer — v1 is offline + rule-based)
- Legal-compliance certification ("can I prospect here?")
- Mining claim management or filing
- Marketplace, social network, or sharing surface
- Commercial-grade GIS (not replacing ArcGIS)
- Assay services, lab integrations, specimen valuation
- Android (deferred until post-v1)
- Multi-user concurrency
- Colorado counties outside the I-70 corridor focus area (Phase 4)
- States other than CO, including Texas (Phase 4)
- Voice interface (deferred)
