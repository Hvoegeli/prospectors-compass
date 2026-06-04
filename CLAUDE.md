# CLAUDE.md — Prospector's Compass

Project-level guardrails for AI coding assistants. Read before making changes.

## Core principle — Offline-first (v1)

This is a **personal backcountry prospecting tool**. The field use case has **no
cell service**, so v1 must work **fully offline**: the desktop app runs locally
(local PostGIS, self-hosted tiles), and the phone app works from downloaded
offline data + GPS with no connectivity.

- **v1 ships NO cloud AI.** The "brain" is a **deterministic, rule-based
  recommendation engine** (weighted-overlay scoring over the PostGIS layers +
  the `spatial/` query tools) plus a **non-AI field guide / dichotomous key** for
  identification. Everything runs locally, instantly, free, and identically every
  run.
- **AI is a documented FUTURE possibility, not a v1 requirement** (see "Deferred:
  optional AI" at the end). If ever added, it must be **optional and online-only**
  research-desk enrichment (used at home/trailhead with signal) whose outputs are
  saved into a Trip and carried offline — never a field-time dependency and never
  required for core function.

## Environment Protection

- **Never modify `.env` without explicit user confirmation.** This file holds secrets.
- **Never commit `.env` files** to git — `.gitignore` already excludes them.
- **Never display API key values** in logs, error messages, or chat output.
- **Never hardcode secrets** in source. Always read from environment via `os.getenv` (Python) or `process.env` (JS/TS).

## Error Logging

When an error or fix takes more than 5 minutes to diagnose, append an entry to `docs/ERROR_FIX_LOG.md` using the template at the top of that file.

**Log:** build failures, runtime errors, source-data API errors (USGS / BLM / CGS / USFS / TNM), database errors (PostGIS), deployment errors, integration failures.

**Do NOT log:** typos, linter warnings, expected test failures (e.g., a snapshot diff that's an intentional change).

## Tech Stack Lock

The following decisions are locked. Do not switch without explicit user approval. New dependencies require justification.

### Backend
- **Language:** Python 3.12+. Do not introduce TypeScript / Go / Rust services.
- **Framework:** FastAPI. Do not switch to Flask / Django.

### Recommendation engine (the v1 "brain")
- **Rule-based weighted-overlay scoring** over the PostGIS layers + `spatial/`
  tools. Deterministic, offline, zero per-use cost. **No LLM / agent framework in
  v1.** Every recommendation must carry its factor-by-factor rationale (see
  Verification).

### Database
- **PostgreSQL 16+ with PostGIS 3.4+.** Runs locally (Docker) so the desktop app
  works offline.
- **pgvector is installed but UNUSED in v1** (it was for AI retrieval). Leave it —
  harmless — and ready if optional AI is added later.
- **Do not switch to MySQL / SQLite for production storage.** SQLite is acceptable for unit-test fixtures only.

### Frontend (desktop)
- **React + TypeScript + Vite.** Do not switch to Next.js / Remix / SvelteKit.
- **Map rendering:** MapLibre GL JS. Do not switch to Mapbox GL JS, Leaflet, or Google Maps.

### Frontend (mobile)
- **React Native + Expo (dev build).** Do not switch to native Swift, Flutter, or Ionic.
- **iOS only for v1.** Do not add Android scaffolding without explicit approval.
- **Map rendering:** MapLibre Native via `@maplibre/maplibre-react-native`.
- **Offline-capable:** bundles downloaded MBTiles + trip data; field features must
  not require connectivity.

### Tile hosting
- **Self-hosted MBTiles served by TileServer GL.** Do not switch to Mapbox-hosted
  tiles. (Self-hosting is what makes offline + mobile bundling possible.)

### Auth
- **Magic-link email (passwordless).** Do not introduce password auth, OAuth providers, or third-party auth services without explicit approval. _(Online-only step — used when syncing, not in the field.)_

### Cost discipline
- **v1 is free to run** — fully offline, no external API per use, so no LLM budget
  is required. (Data-source downloads are one-time and local.) If optional AI is
  added later, reinstate cost discipline then.

### Verification (do not bypass)
- **Recommendations must surface their factor-by-factor rationale** — every scoring
  factor that contributed *is* its evidence (the offline, deterministic analogue of
  "no concrete claim without supporting evidence"). Do not present a recommendation
  without the factors that produced it.
- **Land-status responses always carry the disclaimer.** Do not remove or soften it.
- **Specimen identification below a confidence threshold must NOT name the
  specimen** — it falls back to "field tests" / dichotomous-key guidance. Applies
  to any identifier (rule-based now, AI later).

## Deferred: optional AI (future possibility)

AI is intentionally **out of v1** because of the offline requirement, but is
explicitly preserved as a future option. If it is ever revisited, it must be
**optional and online-only** (never required for offline field use), and the prior
design work is the starting point:

- **Agent runtime:** LangGraph (supervisor + subagents). **Models:** Claude Haiku
  4.5 default, Sonnet 4.6 escape hatch; avoid Opus / non-Anthropic providers.
  **Prompt caching** mandatory; `LLM_MOCK_MODE=true` for dev. **Retrieval:**
  pgvector. **Tracing:** LangSmith. **Budget:** reinstate a hard cap (e.g. $10).
- **Likely first use:** conversational Q&A / plain-English explanation of the
  rule-based results; specimen photo ID (cloud, or an on-device model for offline).
- The subagent response contract (`answer, evidence[], confidence_tag,
  map_features[], reasoning_chain`) and supervisor evidence-enforcement remain the
  intended design if/when AI returns.
