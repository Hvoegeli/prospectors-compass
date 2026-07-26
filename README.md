# Prospector's Compass

**A personal, offline-first backcountry prospecting tool.** It helps recreational
prospectors and rockhounds decide *where to look* for gold, silver, gemstones, and rare
specimens — and *what they've found* in the field — by fusing USGS / state-survey / BLM /
USFS data into a deterministic, rule-based recommendation engine and a non-AI field guide.

> **Offline-first, no cloud AI in v1.** The field use case has no cell service, so the app
> works **fully offline**: the desktop runs a local PostGIS + self-hosted tiles, and the
> iOS app runs from downloaded trip data + GPS with zero connectivity. The "brain" is a
> **deterministic weighted-overlay scoring engine** (not an LLM) — it runs locally,
> instantly, free, and identically every time. AI is a documented *future, optional,
> online-only* enrichment, never a field-time dependency. See [CLAUDE.md](CLAUDE.md).

---

## What it does

Two surfaces, one workflow:

- **Desktop (research + planning)** — Pick a target material (placer/lode gold, silver,
  gems, …). The engine scores candidate areas across the data layers (mineral potential,
  historic districts, land ownership, road access, slope, watershed, hazards) and ranks
  them, each with a **factor-by-factor rationale** and a confidence band — never a black
  box. Explore 16 toggleable map overlays (geology, mines, land status, contours, faults,
  streams, forests, …), inspect any feature for its source attribution, then save an area
  to a **trip** and export it to your phone.
- **iOS mobile (in the field, offline)** — Your GPS position on an offline topo + geology
  map with your planned waypoints. Log finds at your coordinates (kind + note + photo),
  identify a specimen with the offline **dichotomous key** (51 minerals, property-based),
  and carry the trip's scored areas + rationale with you. Send your finds back to the
  desktop via an AirDropped `.pcfinds` bundle.

Land status is always shown with a permanent **"verify with the agency"** disclaimer — the
app never makes a legal go/no-go call.

See [docs/USER_FLOW.md](docs/USER_FLOW.md) for the full trip-planning (Flow A) and in-field
(Flow B) journeys.

---

## Tech stack (locked — see [CLAUDE.md](CLAUDE.md))

| Layer | Choice |
|---|---|
| Backend | Python 3.12 + FastAPI |
| Brain | Rule-based weighted-overlay scoring (no LLM in v1) |
| Database | PostgreSQL 16 + PostGIS 3.4 (local, via Docker) |
| Desktop | React + TypeScript + Vite, MapLibre GL JS |
| Mobile | React Native + Expo (SDK 54), MapLibre Native — iOS only |
| Tiles | Self-hosted MBTiles via TileServer GL |

---

## Quick start (desktop dev)

**Prerequisites:** Docker Desktop, [uv](https://docs.astral.sh/uv/) (Python), Node 20+.

```bash
# 1. Bring up the local stack (Postgres on :1776, TileServer on :8080).
docker compose up -d

# 2. Backend API (:8000).
cd backend && uv sync && uv run uvicorn prospector.main:app --port 8000

# 3. Desktop frontend (http://localhost:5173).
cd frontend && npm install && npm run dev
```

First time only — populate the data layers (one-time downloads into PostGIS):

```bash
cd backend && uv run python -m prospector.ingest all
```

**Run it as a native desktop app** (Tauri shell that starts the whole stack for you), or
build the **self-contained fresh-machine installer** — see
[docs/INSTALL.md](docs/INSTALL.md) and [NEXT_SESSION.md](NEXT_SESSION.md).

## Quick start (iOS app)

```bash
cd mobile
npm install
npx tsc --noEmit     # fast sanity check (expect clean)
npm run ios          # build + launch the iOS dev build in the simulator
```

The app loads a fixture bundle (`mobile/assets/fixture.pcbundle`) so it runs with **no
backend**. In production it opens a `.pcbundle` handed over from the desktop via AirDrop /
Files.

---

## Repository layout

```
backend/     FastAPI app, the scoring engine (prospector/engine), spatial tools
             (prospector/spatial), data ingestion (prospector/ingest), tests
frontend/    React + Vite desktop app (MapView) + the Tauri desktop shell (src-tauri)
mobile/      React Native + Expo iOS field app
infra/       DB init, and the packaging scripts for the fresh-machine distributable
tiles/       Self-hosted basemap (hillshade MBTiles + TileServer config)
docs/        PRD, task list, data-source licensing, engine weights, user flows, install
```

---

## Status

**v1 is feature-complete on both surfaces.** The desktop engine, all map overlays
(including real `gdal_contour` elevation lines), the trip system, the field guide, the
mobile field app (offline maps, GPS, find logging, specimen-ID key), and the desktop↔phone
handoff are all implemented. See [docs/TASK_LIST.md](docs/TASK_LIST.md) for the detailed
breakdown.

**Deferred by design** (not missing work): cloud AI / LLM agents, magic-link auth,
networked sync, and multi-state expansion beyond the Colorado I-70 corridor focus area —
see the "Deferred: optional AI" and "Final / stretch" sections of
[CLAUDE.md](CLAUDE.md) and [docs/PRD.md](docs/PRD.md).

---

## Documentation

- [docs/PRD.md](docs/PRD.md) — product requirements
- [docs/TASK_LIST.md](docs/TASK_LIST.md) — build status by phase
- [docs/USER_FLOW.md](docs/USER_FLOW.md) — the user journeys
- [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) — every ingested dataset + its license
- [docs/ENGINE_WEIGHTS.md](docs/ENGINE_WEIGHTS.md) — the scoring weights and rationale
- [docs/INSTALL.md](docs/INSTALL.md) — installing the packaged desktop app
- [CLAUDE.md](CLAUDE.md) — project guardrails (offline-first, stack lock, verification)
