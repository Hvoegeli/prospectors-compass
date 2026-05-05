# CLAUDE.md — Prospector's Compass

Project-level guardrails for AI coding assistants. Read before making changes.

## Environment Protection

- **Never modify `.env` without explicit user confirmation.** This file holds secrets.
- **Never commit `.env` files** to git — `.gitignore` already excludes them.
- **Never display API key values** in logs, error messages, or chat output.
- **Never hardcode secrets** in source. Always read from environment via `os.getenv` (Python) or `process.env` (JS/TS).

## Error Logging

When an error or fix takes more than 5 minutes to diagnose, append an entry to `docs/ERROR_FIX_LOG.md` using the template at the top of that file.

**Log:** build failures, runtime errors, API errors (USGS / BLM / Anthropic), database errors (PostGIS / pgvector), deployment errors, integration failures.

**Do NOT log:** typos, linter warnings, expected test failures (e.g., a snapshot diff that's an intentional change).

## Tech Stack Lock

The following decisions are locked. Do not switch without explicit user approval. New dependencies require justification.

### Backend
- **Language:** Python 3.12+. Do not introduce TypeScript / Go / Rust services.
- **Framework:** FastAPI. Do not switch to Flask / Django.
- **Agent runtime:** LangGraph. Do not introduce CrewAI / AutoGen / custom orchestration.

### LLM
- **Default model:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`). Use this for every subagent unless there's an explicit reason otherwise.
- **Escape hatch:** Claude Sonnet 4.6. Used only when Haiku synthesis fails on golden eval cases. Never the default.
- **Do not use:** Claude Opus 4.7 (cost), GPT / Gemini / open-source LLMs (provider lock).
- **Prompt caching:** mandatory on every supervisor and subagent call. Cache system prompts and tool definitions.

### Database
- **PostgreSQL 16+ with PostGIS 3.4+ and pgvector 0.7+.** One database for spatial AND vector.
- **Do not introduce a separate vector DB** (Pinecone, Weaviate, Qdrant, etc.) without explicit approval.
- **Do not switch to MySQL / SQLite for production storage.** SQLite is acceptable for unit-test fixtures only.

### Frontend (desktop)
- **React + TypeScript + Vite.** Do not switch to Next.js / Remix / SvelteKit.
- **Map rendering:** MapLibre GL JS. Do not switch to Mapbox GL JS, Leaflet, or Google Maps.

### Frontend (mobile)
- **React Native + Expo (dev build).** Do not switch to native Swift, Flutter, or Ionic.
- **iOS only for v1.** Do not add Android scaffolding without explicit approval.
- **Map rendering:** MapLibre Native via `@maplibre/maplibre-react-native`.

### Tile hosting
- **Self-hosted MBTiles served by TileServer GL.** Do not switch to Mapbox-hosted tiles.

### Observability
- **LangSmith free tier.** Do not add a second tracer (Langfuse, Braintrust, etc.).

### Auth
- **Magic-link email (passwordless).** Do not introduce password auth, OAuth providers, or third-party auth services without explicit approval.

### Cost discipline
- **Build + initial deploy budget: $10 hard cap.**
- **Always use prompt caching.**
- **Use `LLM_MOCK_MODE=true` for UI iteration** that doesn't need real subagent responses.
- **Never run the full eval suite without confirming budget headroom** — it touches live Anthropic.

### Verification (do not bypass)
- Subagent response contract: `{answer, evidence[], confidence_tag, map_features[], reasoning_chain}`. Do not strip fields.
- Supervisor enforces "no concrete claim without supporting evidence." Do not weaken this check.
- Land-status responses always carry the disclaimer. Do not remove or soften it.
- Specimen ID below 60% confidence is structurally locked into "field tests" mode (`naming_locked: true`). Do not add a code path that names the specimen below threshold.
