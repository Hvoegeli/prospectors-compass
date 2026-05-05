# Tech Stack — Prospector's Compass

## Architecture Overview

```
┌──────────────────────────────────┐    ┌──────────────────────────┐
│  Desktop Web                     │    │  iOS Mobile              │
│  React + TypeScript + Vite       │    │  React Native + Expo     │
│  + MapLibre GL JS                │    │  + MapLibre Native       │
└──────────────┬───────────────────┘    └──────────────┬───────────┘
               │                                       │
               │   HTTPS (REST + SSE)                  │   HTTPS
               └───────────────────┬───────────────────┘
                                   │
                         ┌─────────▼──────────────┐
                         │  FastAPI backend       │
                         │  (Python 3.12, async)  │
                         └─────────┬──────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
       ┌──────▼─────┐       ┌──────▼──────┐      ┌─────▼──────┐
       │ LangGraph  │       │ PostgreSQL  │      │ TileServer │
       │ supervisor │       │ + PostGIS   │      │ GL         │
       │ + 7 sub-   │       │ + pgvector  │      │ (MBTiles)  │
       │ agents     │       └─────────────┘      └────────────┘
       └──────┬─────┘
              │
       ┌──────▼─────┐
       │ Anthropic  │
       │ Haiku 4.5  │  (default)
       │ Sonnet 4.6 │  (escape hatch only)
       └────────────┘
```

## Stack Decisions

| Layer | Technology | Version | Rationale |
|---|---|---|---|
| Backend language | Python | 3.12+ | LangGraph idiomatic; async; strong spatial libs |
| Backend framework | FastAPI | 0.115+ | Async, lightweight, SSE for streaming subagent progress |
| Agent orchestration | LangGraph | latest | Native fit for supervisor + subagent topology; matches existing experience |
| LLM (default) | Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | Fits $10 cap; vision; function calling |
| LLM (escape hatch) | Claude Sonnet 4.6 | `claude-sonnet-4-6` | Used only when Haiku synthesis visibly fails on golden eval |
| Database | PostgreSQL + PostGIS + pgvector | PG 16+, PostGIS 3.4+, pgvector 0.7+ | Single DB for spatial AND vector; minimizes infra |
| Map rendering (web) | MapLibre GL JS | 4.x | Free, MBTiles-compatible, mature |
| Map rendering (mobile) | MapLibre Native | 11.x | Offline-first, MBTiles support |
| Tile server | TileServer GL | 5.x | Free, serves MBTiles to web clients |
| Knowledge corpus | pgvector (in same DB) | 0.7+ | Embedded retrieval; co-located with PostGIS for joint queries |
| Frontend (desktop) | React + TypeScript + Vite | React 18, TS 5.x | Mainstream; AI-tool-friendly |
| Frontend (mobile) | React Native + Expo (dev build) | RN 0.76+, Expo SDK 52+ | Shared TS types with desktop; preserves Android optionality |
| Auth | Magic-link email | — | Lowest-friction for single-user hobby |
| Observability | LangSmith free tier | — | Native LangGraph trace integration |
| Map data format | MBTiles | — | Self-hostable; bundle into mobile for offline |

## Key Dependencies

### Backend
- `langgraph` — supervisor + subagent state graph
- `langchain-anthropic` — Anthropic provider for LangGraph
- `anthropic` — direct SDK for explicit prompt caching control
- `fastapi`, `uvicorn` — API + ASGI server
- `sqlalchemy`, `geoalchemy2` — ORM with PostGIS support
- `psycopg[binary]` — Postgres driver
- `pgvector` — Python bindings for pgvector
- `pydantic` — schema validation including subagent contracts
- `python-dotenv` — env loading
- `langsmith` — observability traces
- `httpx` — outbound HTTP for any USGS/BLM API supplements
- `pytest`, `pytest-asyncio` — unit + integration tests
- `ruff` — lint/format

### Frontend (desktop)
- `react`, `react-dom`, `typescript`
- `maplibre-gl` — map canvas
- `@tanstack/react-query` — data fetching
- `zustand` — lightweight state
- `vite` — build tool
- `eslint`, `prettier` — lint/format

### Frontend (mobile, RN + Expo)
- `react-native`, `expo`
- `@maplibre/maplibre-react-native` — offline map rendering
- `expo-location` — GPS
- `expo-camera` — specimen photo
- `expo-secure-store` — magic-link session token storage
- `@tanstack/react-query` — shared data layer with desktop

## Environment Variables

```env
# === Anthropic (LLM) ===
ANTHROPIC_API_KEY=

# === Database ===
DATABASE_URL=postgresql://prospector:prospector@localhost:5432/prospector
PGVECTOR_DIM=1536

# === LangSmith (observability) ===
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=prospectors-compass
LANGSMITH_TRACING=true

# === Auth (magic-link email) ===
RESEND_API_KEY=
AUTH_SIGNING_SECRET=

# === Tile server / maps ===
TILESERVER_URL=http://localhost:8080
MBTILES_DIR=./tiles

# === Cost guardrails ===
ANTHROPIC_BUDGET_SOFT_USD=5
ANTHROPIC_BUDGET_HARD_USD=8

# === Dev mode ===
LLM_MOCK_MODE=false
```

## Database Schema

All geometries use SRID 4326 (WGS84).

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Trips
CREATE TABLE trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name TEXT,
  starts_at DATE,
  ends_at DATE,
  area_geom GEOMETRY(Polygon, 4326),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE waypoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  label TEXT,
  geom GEOMETRY(Point, 4326) NOT NULL,
  notes TEXT
);

-- Finds (append-only)
CREATE TABLE finds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES trips(id),
  geom GEOMETRY(Point, 4326) NOT NULL,
  photo_path TEXT,
  specimen_id_result JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- USGS / state survey records
CREATE TABLE mrds_sites (
  id TEXT PRIMARY KEY,         -- USGS MRDS dep_id
  name TEXT,
  commodity TEXT[],
  geom GEOMETRY(Point, 4326),
  raw JSONB,
  state TEXT
);
CREATE INDEX mrds_geom_idx ON mrds_sites USING GIST (geom);

CREATE TABLE usmin_sites (
  id TEXT PRIMARY KEY,
  name TEXT,
  geom GEOMETRY(Point, 4326),
  raw JSONB,
  state TEXT
);
CREATE INDEX usmin_geom_idx ON usmin_sites USING GIST (geom);

CREATE TABLE geology_units (
  id BIGSERIAL PRIMARY KEY,
  unit_label TEXT,
  description TEXT,
  geom GEOMETRY(MultiPolygon, 4326),
  source TEXT,                 -- "USGS_NGMDB" | "CGS" | "TXBEG"
  state TEXT
);
CREATE INDEX geology_units_geom_idx ON geology_units USING GIST (geom);

CREATE TABLE land_status (
  id BIGSERIAL PRIMARY KEY,
  agency TEXT,                 -- "BLM" | "USFS" | "NPS" | etc.
  designation TEXT,            -- "Wilderness" | "National Forest" | etc.
  geom GEOMETRY(MultiPolygon, 4326),
  as_of DATE NOT NULL
);
CREATE INDEX land_status_geom_idx ON land_status USING GIST (geom);

-- Knowledge corpus chunks
CREATE TABLE corpus_chunks (
  id BIGSERIAL PRIMARY KEY,
  source_doc TEXT NOT NULL,    -- citation key
  source_url TEXT,
  license TEXT NOT NULL,       -- "public-domain" | "open-access"
  chunk_text TEXT NOT NULL,
  embedding VECTOR(1536),
  state TEXT
);
CREATE INDEX corpus_chunks_embed_idx ON corpus_chunks USING ivfflat (embedding vector_cosine_ops);

-- Eval run log
CREATE TABLE eval_runs (
  id BIGSERIAL PRIMARY KEY,
  case_id TEXT,
  ran_at TIMESTAMPTZ DEFAULT now(),
  passed BOOLEAN,
  trace_url TEXT,
  cost_usd NUMERIC
);
```

## API Endpoints Summary

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/magic-link` | Request magic link sent to email |
| GET | `/auth/verify` | Verify magic link, set session |
| GET | `/trips` | List user trips |
| POST | `/trips` | Create trip |
| GET | `/trips/{id}` | Trip detail (waypoints, finds, area) |
| PATCH | `/trips/{id}` | Update trip metadata |
| POST | `/trips/{id}/waypoints` | Add waypoint |
| POST | `/trips/{id}/finds` | Append a find (mobile) |
| POST | `/agent/query` | Submit query to supervisor; returns SSE stream |
| POST | `/agent/specimen-id` | Vision call — image + GPS → ranked specimen candidates |
| GET | `/data/area-export/{trip_id}` | Bundle MBTiles + cached subagent results for offline mobile |
| GET | `/eval/run` | Trigger manual eval run (dev-only) |
