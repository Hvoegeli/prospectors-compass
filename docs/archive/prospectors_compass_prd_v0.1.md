> **⚠️ ARCHIVED — superseded by [`docs/PRD.md`](../PRD.md).**
> This is the original v0.1 draft (2026-05-05), kept as a historical source. It predates the
> scope cuts (Texas → Phase 4; Colorado narrowed to the I-70 corridor) and the tech-stack lock.
> Do **not** treat it as the live spec. Revive Texas/Android/expansion details from here when Phase 4 begins.

# Prospector's Compass — Product Requirements Document

**Working name:** Prospector's Compass
**Author:** Harrison Voegeli
**Status:** Draft v0.1
**Last updated:** May 5, 2026
**Project type:** Personal / hobby project

---

## 1. Executive Summary

Prospector's Compass is a hobbyist-focused application that helps recreational prospectors and rockhounds find promising places to look for valuable metals (gold, silver, copper, platinum, and other native metal nuggets) and gemstones in the United States. It combines open-source geological, topographical, and historical mining data with an AI agent system to deliver location recommendations, interactive maps, educational guidance, and field-grade specimen identification.

The product is built around a **two-surface model**: a **desktop experience** for at-home research and trip planning, and a **companion mobile app** for use in the field with offline maps, GPS tracking, and live photo-based identification of specimens.

Under the hood, the app uses a **supervisor + subagent architecture** to decompose user questions across distinct knowledge domains (geology, GIS/mapping, mining history, land status, field technique, specimen ID) and synthesize comprehensive answers grounded in authoritative open-source data.

The launch scope is intentionally narrow — Colorado and Texas — with a clean expansion path to additional states.

---

## 2. Problem & Vision

### 2.1 Problem

Hobbyist prospectors today face a fragmented information landscape:

- USGS, state geological surveys, BLM, USFS, and historical mining records all live in different portals with different formats and inconsistent UX.
- Prospecting guides and geology textbooks contain gold (literally and figuratively) but are not searchable by location or cross-referenced with modern data.
- "Where should I prospect this weekend?" is a question that requires synthesizing geology, terrain, historical mining activity, land access, and the specific material the user is hunting — and most hobbyists don't have the time or expertise to do that synthesis.
- In the field, hobbyists often have weak cell coverage, no easy way to identify a specimen they just picked up, and no quick check on whether a feature in front of them is geologically promising.

### 2.2 Vision

A hobbyist opens the desktop app on Friday night, picks a region of Colorado, asks "where should I look for placer gold this weekend that's accessible from Denver?", and gets back a ranked list of areas with rationale, a topo + geologic + historic-mine overlay map, technique recommendations for that ground type, and a packing checklist. They sync the area for offline use, drive to the trailhead Saturday, and the mobile app guides them through the day — GPS waypoints, on-the-fly specimen photo ID, and the ability to ask the agent questions about anything they encounter.

The product treats the user as an intelligent learner, not a passive consumer: every recommendation is **explainable**, every map layer is **interpretable**, and the user comes away from each trip knowing more geology than they did before.

---

## 3. Goals & Non-Goals

### 3.1 Goals (v1)

- Help hobbyist prospectors identify high-potential areas to prospect for gold, silver, copper, platinum, gemstones, and rare/collector specimens.
- Provide rich, interactive maps with geological, topographical, and historical-mining overlays.
- Provide educational, location-aware guidance on what to look for and how to prospect.
- Surface land-status information (BLM, USFS, public/private) as a research aid, while making clear that legal compliance is the user's responsibility.
- Work seamlessly across desktop (research) and mobile (field), including offline use.
- Identify specimens from field photos with helpful, calibrated confidence.

### 3.2 Non-Goals (v1)

- Not a legal-compliance tool. The app does not certify whether prospecting is legal at any specific point. It surfaces information; the user does the verification.
- Not a mining claim management or filing tool.
- Not a marketplace or social network for prospectors.
- Not commercial-grade GIS software (e.g., does not aim to replace ArcGIS).
- Not a replacement for in-person mentorship, club membership, or formal geology education.
- No assay services, lab integrations, or specimen valuation/appraisal.

---

## 4. Target User & Personas

### 4.1 Primary persona — "Weekend Pan" Pete

- 45-year-old project manager in suburban Denver.
- Has panned for gold a half-dozen times, owns a basic kit, watches prospecting YouTube channels.
- Wants to plan productive weekend trips within a 3-hour drive.
- Knows what a placer deposit is but couldn't describe Colorado's geology in detail.
- Comfortable with a phone and a laptop. Not technical with GIS tools.

### 4.2 Secondary persona — "Curious Newcomer" Carla

- 32-year-old teacher, recently moved to Texas, fascinated by rockhounding after a trip to Big Bend.
- Has never prospected. Wants to learn what's possible in Texas (agate, topaz, fossils, pegmatite minerals, etc.).
- Needs the app to teach her, not assume expertise.
- Values explainability — wants to know why an area is recommended.

### 4.3 Tertiary persona — "Avid Hobbyist" Hank

- 60-year-old retired engineer, dedicated rockhound for 15 years.
- Already knows the popular districts; wants to explore lesser-known ground and unusual targets.
- Will dig into raw data if the app surfaces it well.
- Heavy power user of mobile in the field; uses offline maps extensively.

---

## 5. User Journeys

### 5.1 Journey A — Trip Planning (Desktop)

1. User logs in to desktop app, picks "Colorado" from the state selector.
2. User types or selects a target: "placer gold within 2 hours of Denver, beginner-friendly."
3. The supervisor agent decomposes the query and routes to subagents (Geology, History, Maps, Field Guidance, Land Status).
4. Within ~30 seconds the user sees:
   - A ranked list of 3–7 candidate areas with one-paragraph rationales.
   - An interactive map with selectable overlays (geologic units, topo, historic mines, land status, drainage).
   - A "what to look for" guide tailored to placer gold in Colorado Front Range geology.
   - A "before you go" checklist (gear, water, access, terrain warnings).
5. User pins a top candidate, downloads the area for offline mobile use, and creates a trip in their account.

### 5.2 Journey B — In the Field (Mobile)

1. User arrives at the planned area; opens the mobile app, which is already cached.
2. App shows current location on the topo + geology overlay; the planned waypoints are visible.
3. User pans a creek and finds something glittery. Snaps a photo through the app.
4. The Specimen ID Agent (vision + geology context) returns: most likely identification, confidence, and a short "what to do next" guide ("looks like pyrite — here are three quick field tests to differentiate from gold").
5. User logs the find with GPS coordinates and notes; this is saved back to their trip log for review at home.

### 5.3 Journey C — Learning Loop (Desktop)

1. User opens app with no specific destination — just "I want to learn about Texas pegmatite minerals."
2. The Knowledge/Education Agent produces a structured primer with links to in-app maps showing pegmatite-bearing regions, recommended reading, and a starter shopping list of indicator minerals to recognize.
3. User bookmarks the primer; next weekend, this becomes the seed for a planned trip via Journey A.

---

## 6. Product Surfaces

### 6.1 Desktop (Web)

- Primary research surface. Optimized for large screen, multi-panel layouts (map + chat + data inspector).
- Built as a web app for cross-platform compatibility (macOS, Windows, Linux). Mobile browsers can use it but mobile-native is preferred for field use.
- Heavy use of map rendering (Mapbox / MapLibre / Leaflet — see §10).

### 6.2 Mobile (iOS + Android)

- Companion app for field use.
- Core capabilities:
  - Offline maps and data caching for previously researched areas.
  - GPS tracking with waypoints, route logging, and find-pins.
  - Live agent chat with photo attachments (Specimen ID Agent).
  - Sync trip logs back to the desktop account.
- Field-first UX: large tap targets, glove-friendly, sun-readable, battery-conservative.

### 6.3 Cross-surface account & sync

- Single user account; trips, saved areas, finds, and chat history sync between desktop and mobile.
- Conflict policy: last-write-wins on metadata; finds and waypoints append-only.

---

## 7. Core Features

### 7.1 State / Region Selection

- User picks a US state. v1 supports Colorado and Texas. UI clearly indicates which states are "supported" vs "coming soon."
- Within a state, user can drill down by county, region, named district, or by drawing a custom polygon on the map.

### 7.2 Target-Material Selection

- User selects one or more target materials: gold (placer / lode), silver, copper, platinum, native nuggets of other rare metals, gemstones (with sub-categories: quartz, topaz, beryl, tourmaline, garnet, etc.), and rare/collector specimens (meteorites, fossils, fluorescent minerals, rare earth indicators).
- Selections feed all downstream agent reasoning.

### 7.3 Recommendation Engine

- Given (state, target material, optional constraints like distance/difficulty/season), produce a ranked list of candidate areas.
- Each recommendation includes:
  - Area name and bounding region on the map.
  - Plain-language rationale ("This area sits on the Idaho Springs–Ralston shear zone with documented placer workings on Clear Creek tributaries…").
  - Confidence band (Low / Moderate / High) with explanation.
  - Pointers to specific subagent outputs (geology, history, terrain) for deeper dives.

### 7.4 Interactive Maps

- Base layers: USGS topo, satellite/NAIP imagery, terrain hillshade.
- Overlay layers (toggleable):
  - Geologic units (state geological survey data).
  - Historic mines and prospects (MRDS / USMIN).
  - Public land status (BLM / USFS) — informational, with disclaimer.
  - Drainages and watersheds.
  - User's own pins, tracks, and finds.
- Click-to-inspect on any feature: displays the underlying record(s) with source attribution.

### 7.5 Educational / "What to Look For" Guidance

- Material- and location-specific guidance: indicator minerals, host rocks, weathering signatures, drainage patterns to follow, ideal stream geometry for placer, etc.
- Technique recommendations: panning, sluicing, dry washing, crevicing, metal detecting, gemstone surface hunting, etc.
- Safety and access notes: terrain, weather windows, abandoned mine hazards.

### 7.6 Land-Status Surfacing

- Display BLM / USFS / private boundaries on the map.
- Surface known active mining claims layers where data is available, with "as of" dates clearly shown.
- Prominent disclaimer on every land-status panel: **"This is not legal advice. Verify land status, claim status, and prospecting rules with the relevant agency before digging."**

### 7.7 Specimen Identification (Photo)

- Mobile-first: point camera at a specimen, get a vision-model identification with confidence.
- Augmented by location context: the agent knows what's geologically plausible at the user's GPS coordinates.
- Output includes: top candidates with confidence, distinguishing field tests, and "what this means for your prospect" interpretation.
- Accuracy expectations and limits clearly communicated (see §13 Risks).

### 7.8 Trip Log

- Trips group: a date range, an area, planned waypoints, GPS tracks, finds, photos, and the agent chat history from that trip.
- Reviewable on desktop after the fact.
- Foundation for future features (export, sharing, learning-from-history).

### 7.9 Conversational Agent Interface

- A persistent chat surface alongside the map (desktop) or as a primary surface (mobile).
- Users can ask free-form questions; the supervisor agent routes them.
- Agent responses always cite sources and link back to relevant map features where possible.

---

## 8. Agent Architecture

### 8.1 Overview

The system uses a **supervisor + subagent** architecture. The supervisor receives every user request, decomposes it into subtasks, dispatches them to specialized subagents (in parallel where possible), and synthesizes the results into a coherent, cited answer. Subagents do not talk to each other directly — only through the supervisor, to keep reasoning auditable.

```
                          ┌────────────────────────┐
                          │   User (desktop/mobile)│
                          └───────────┬────────────┘
                                      │
                          ┌───────────▼────────────┐
                          │   Supervisor Agent     │
                          │  (orchestrator/router) │
                          └─┬──┬──┬──┬──┬──┬──┬────┘
                            │  │  │  │  │  │  │
        ┌───────────────────┘  │  │  │  │  │  └────────────────┐
        │       ┌──────────────┘  │  │  │  └──────────┐         │
        │       │     ┌───────────┘  │  └────┐         │        │
        ▼       ▼     ▼              ▼       ▼         ▼        ▼
  ┌─────────┐┌─────┐┌──────┐    ┌────────┐┌──────┐┌────────┐┌────────┐
  │Geology  ││Maps ││Mining│    │ Land   ││Field ││Specimen││ Edu /  │
  │ Agent   ││/ GIS││History│   │Status  ││Guide ││  ID    ││ Knowl. │
  │         ││Agent││Agent │    │ Agent  ││Agent ││ Agent  ││ Agent  │
  └─────────┘└─────┘└──────┘    └────────┘└──────┘└────────┘└────────┘
```

### 8.2 Supervisor Agent

**Responsibility:** Route, plan, synthesize.

- Parses user intent (research vs. field question vs. learning).
- Decomposes into subagent tasks; runs them in parallel when independent.
- Resolves conflicts between subagent outputs (e.g., geology says "promising" but history says "no recorded production" — surface both).
- Produces the final response with inline source citations and links to map features.
- Maintains conversation memory and trip context.

### 8.3 Geology Agent

**Responsibility:** Geological reasoning about a location and target material.

- Knows formations, host rocks, mineralization processes, indicator minerals, alteration signatures.
- Queries: state geological survey datasets, USGS national geologic map database, scientific literature summaries.
- Outputs: "what's the rock here, why does it matter for your target, what would an experienced geologist look for."

### 8.4 Maps & GIS Agent

**Responsibility:** Spatial queries, map composition, terrain analysis.

- Resolves user-described areas into geometries (polygons, buffers, watersheds).
- Composes overlay stacks for the UI; performs intersection queries (e.g., "show me historic gold placers within USFS land in this watershed").
- Performs simple terrain analysis: slope, aspect, drainage delineation, accessibility from roads.

### 8.5 Mining History Agent

**Responsibility:** Historical context.

- Queries MRDS, USMIN, state-survey historic-mine inventories.
- Surfaces production records, district histories, ghost towns, abandoned mine warnings.
- Connects historic activity to modern opportunity ("this district produced gold from these formations; the same formations extend north into accessible USFS land").

### 8.6 Land Status Agent

**Responsibility:** Informational land-status surfacing.

- Queries BLM / USFS land boundaries, claim layers (where available), special designations (wilderness, national monuments, tribal lands, state parks).
- **Always** outputs the standard disclaimer that the user must verify legality independently.
- Will not produce a "go/no-go" determination.

### 8.7 Field Guidance Agent

**Responsibility:** Practical prospecting advice.

- Encodes prospecting techniques and gear from prospecting guides.
- Tailors advice to the area, terrain, and target material.
- Produces packing lists, technique walkthroughs, safety notes.

### 8.8 Specimen ID Agent

**Responsibility:** Identify specimens from field photos.

- Vision model + geology context (uses GPS to constrain plausible identifications).
- Returns ranked candidates with confidence, distinguishing characteristics, and quick field tests.
- Conservative defaults: if confidence is low, says so plainly rather than guessing.

### 8.9 Education / Knowledge Agent

**Responsibility:** Explain concepts and answer learning-oriented questions.

- Pulls from a curated knowledge base built from geology textbooks, prospecting guides, and survey publications.
- Produces structured primers, glossary entries, and "go deeper" reading lists.
- Cross-links to map features so learning stays grounded in real places.

### 8.10 Inter-agent contract

Each subagent exposes a structured response with:
- A concise answer the supervisor can quote or paraphrase.
- A list of evidence items, each with source, URL/citation, and a confidence tag.
- An optional list of map features (geometries) the supervisor can render.
- An optional follow-up suggestion ("the user might also want to ask…").

This contract makes synthesis predictable and auditable.

---

## 9. Data Sources

### 9.1 Federal

- **USGS** — national geologic map database, MRDS (Mineral Resources Data System), USMIN (historic mines), topographic maps, DEM, NAIP imagery.
- **BLM** — public land boundaries and (where available) claim status data.
- **USFS** — national forest boundaries and access information.

### 9.2 State (launch states)

- **Colorado Geological Survey** — state geologic maps, mineral resource publications, historic mining district reports.
- **Texas Bureau of Economic Geology** — geologic atlas of Texas, mineral resources of Texas publications.

### 9.3 Knowledge corpus

- Curated extracts from publicly available prospecting guides and geology textbooks (subject to license review).
- Open-access scientific literature (e.g., USGS Open-File Reports, state survey bulletins).

### 9.4 Data freshness & versioning

- Each dataset is versioned and dated in the app's data inspector.
- Mining history data is mostly historical and changes slowly; land-status data must be refreshed regularly (target: monthly minimum).

---

## 10. Technical Considerations

This is a hobby project; the technical section is intentionally lightweight and meant to be expanded into a separate technical design doc.

- **Frontend (desktop):** Web app — React or similar, with Mapbox GL / MapLibre / Leaflet for mapping.
- **Mobile:** React Native or Flutter for shared-codebase iOS/Android, with offline tile and data caching (e.g., MBTiles + SQLite).
- **Backend:** Lightweight API service (Python/FastAPI or Node) hosting agent orchestration and data access.
- **Agent runtime:** LLM provider with tool/function-calling; subagents implemented as separate prompt/tool bundles. Vision model for Specimen ID.
- **Data storage:** PostGIS for spatial data; object storage for tiles/imagery; vector DB for the knowledge corpus.
- **Authentication:** OAuth / passwordless email link; single user identity across desktop and mobile.
- **Privacy:** GPS tracks and finds are private by default; no sharing surface in v1.

---

## 11. Success Metrics

Because this is a hobby project, "success" is defined in user-experience terms rather than business KPIs.

- **Quality of recommendations:** at least 70% of recommendations rated "useful" by the user (in-app thumbs-up/down).
- **Trip productivity:** users who plan a trip in the app report finding *something* (anything noteworthy) on >50% of trips.
- **Learning:** users who use the app for 4+ weeks self-report measurably increased confidence in identifying rocks/minerals.
- **Field reliability:** mobile app works offline for ≥95% of cached-area sessions without crashes or data loss.
- **Specimen ID accuracy:** top-1 correct on common specimens ≥80%; calibrated confidence (when the model says "high confidence" it's right ≥90% of the time).

---

## 12. Phased Roadmap

### Phase 0 — Foundations (4–6 weeks)
- Set up data ingestion for USGS, MRDS/USMIN, BLM/USFS, Colorado and Texas state survey data.
- Stand up basic desktop web app with map rendering and state selector.
- Implement supervisor agent + Geology, Maps/GIS, and Mining History subagents (the minimum viable trio).

### Phase 1 — MVP (research surface) (6–8 weeks)
- Add Land Status, Field Guidance, and Education subagents.
- Recommendation engine with ranked candidate areas.
- Trip planning: save areas, create a trip, define waypoints.
- Account system + sync foundation.

### Phase 2 — Mobile field app (6–10 weeks)
- iOS + Android app with offline maps, GPS tracking, waypoints.
- Trip sync between desktop and mobile.
- Conversational agent surface in the field.

### Phase 3 — Specimen ID (4–6 weeks)
- Specimen ID Agent (vision model + geology context).
- Integrated into mobile camera flow and find-logging.

### Phase 4 — Expansion
- Add states beyond CO and TX. Priority: high-prospecting-value Western states (CA, NV, AZ, ID, MT, NM, UT, OR, WA, AK).
- Improve depth on launch states based on user feedback.
- Knowledge-corpus expansion: more textbooks, more prospecting guides, more state-survey publications.

---

## 13. Risks & Mitigations

- **Bad recommendations leading users to wasted trips.**
  *Mitigation:* always show rationale and confidence; make it easy for users to flag bad recommendations; learn from feedback.

- **Misleading land-status info causing legal trouble.**
  *Mitigation:* prominent, repeated disclaimers; conservative defaults; never produce a "you can prospect here" determination; encourage user verification with the relevant agency.

- **Specimen ID overconfidence (calling pyrite "gold").**
  *Mitigation:* calibrated confidence; default to suggesting field tests rather than asserting identity; explicit "low confidence — try these tests" mode.

- **Abandoned mine and terrain hazards.**
  *Mitigation:* Field Guidance Agent explicitly surfaces hazards in any recommendation; safety section in trip checklist.

- **Data licensing.**
  *Mitigation:* prefer public-domain federal sources and open-access state publications; document the licensing of every dataset and any text used in the knowledge corpus; remove anything with unclear rights.

- **LLM hallucination ("there's gold at exactly these coordinates").**
  *Mitigation:* every concrete claim must be tied to a cited source from a subagent; supervisor enforces "no claim without citation" before responding.

- **Cost (LLM + map tile + storage).**
  *Mitigation:* aggressive caching for repeated queries within an area; small/cheap models for routine subagent tasks; reserve expensive models for synthesis and vision.

- **Encouraging trespassing or environmental damage.**
  *Mitigation:* educate on Leave No Trace and small-scale prospecting ethics; refuse to recommend areas known to be off-limits; never recommend defacing public lands.

---

## 14. Open Questions

1. **Knowledge corpus sourcing.** Which prospecting guides and textbooks can be ingested under acceptable license terms? Need a licensing review pass before Phase 1.
2. **Active claim data quality.** BLM claim data (LR2000 / MLRS) is notoriously messy and lagging; how much investment is right for v1 vs. just pointing users at the official portal?
3. **Specimen ID training data.** Build a custom dataset, fine-tune a vision model, or rely on prompted general-purpose vision models? Prototype to decide.
4. **Tile hosting cost.** Self-host MBTiles vs. paid Mapbox tier — depends on expected user count.
5. **Trip-log privacy.** Default-private is correct, but is there value in optional anonymous aggregation (e.g., "most-prospected areas this season") later? Defer.
6. **Mobile platform priority.** iOS and Android simultaneously, or iOS first to keep scope tight?
7. **Voice interface in the field.** Hands-free voice queries while panning could be a delightful field feature — defer to post-v1 but worth prototyping.

---

## 15. Glossary (selected)

- **Placer deposit** — a deposit of valuable minerals (often gold) accumulated by mechanical concentration in stream gravels or other sediments.
- **Lode deposit** — a vein of mineralization in solid rock; the original source of placer material.
- **MRDS** — Mineral Resources Data System; USGS database of mineral occurrences and deposits.
- **USMIN** — USGS database of mine and mineral processing site records.
- **BLM** — Bureau of Land Management; manages much of the federal public land in the western US.
- **USFS** — US Forest Service; manages national forests, where prospecting rules vary.
- **MLRS** — Mineral and Land Records System; the BLM's modern claim recording system, replacing LR2000.
- **DEM** — Digital Elevation Model; gridded terrain elevation data.
- **NAIP** — National Agriculture Imagery Program; high-resolution aerial imagery of the US.
