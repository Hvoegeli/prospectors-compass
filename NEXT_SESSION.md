# Next Session — Where We Left Off

_Last session: 2026-05-21_

## State of the project

- **Branch:** `scope/colorado-i70-corridor` (doc-only scope-change commit; **not yet merged to `main`**). `main` is still at `e4eefed`.
- **Group 1 (Project setup):** 7 of 8 subtasks complete and merged.
- **Group 2 (Data ingestion CO — I-70 corridor focus area):** not started. _(Texas dropped from v1 — deferred to Phase 4. CO narrowed to 10 focus-area counties — see PRD §7.1.)_

## What changed this session (2026-05-21) — scope cuts

Two scope decisions, applied across all 7 project docs (PRD, TASK_LIST, TESTING_STRATEGY, USER_FLOW, MEMO, presearch, this file):

1. **Texas dropped from v1 → demoted to Phase 4.** Not deleted — TX BEG data, eval cases, and examples are preserved as explicit "deferred to Phase 4" notes, easy to revive.
2. **Colorado narrowed to the I-70 corridor focus area** — 10 counties (Denver, Jefferson, Clear Creek, Gilpin, Park, Summit, Lake, Eagle, Garfield, Mesa). Defined canonically **once** in PRD §7.1; every other doc references "the I-70 corridor focus area" by name to avoid drift. Rest-of-Colorado is Phase 4. Group 2 ingestion is now county-clipped.

## What's running locally

You may have left these up between sessions — re-check before starting:

```bash
docker compose ps                # is the postgres container still healthy?
docker compose up -d             # bring it back up if stopped
```

Postgres is at `localhost:1776`, db `prospector`, user `prospector`, pwd `prospector`. Both PostGIS 3.4.3 and pgvector 0.8.2 are loaded.

> **Port note (2026-06-01):** Host port is **1776**, not 5432 — 5432 was already taken by another project's container + an ssh tunnel on this machine. The container still speaks 5432 internally; `docker-compose.yml`, `.env`, and `config.py` are all set to 1776.

## Still to do / outstanding

- **Merge `scope/colorado-i70-corridor` → `main`** when you're ready to publish the scope change. Doc-only, no code touched. (Left on the branch per the "main stays untouched until you say so" rule.)
- **Subtask 8 — Anthropic console budget alerts.** Manual web action (carried over from last session).
  - Go to console.anthropic.com → Settings → Limits.
  - Set hard cap **$8** and alert at **$5**.
  - Then check the box in `docs/TASK_LIST.md` group 1.
- **Region selector sub-regions (deferred, implementation-level).** The `state: "CO"` API field in `docs/USER_FLOW.md` was left as-is. If the selector should pick *sub-regions within* the corridor (vs. one CO region), spec it when building Group 7 (recommendation engine / selector UI). No action needed now.

## To resume

```bash
cd "/Users/harrisonvoegeli/Desktop/projects/Unfinished Projects/prospectors-compass"
docker compose up -d                       # postgres (host port 1776)
cd backend && uv run pytest                # sanity (expect 10/10 green)
```

> **If `uv run pytest` fails to spawn:** the project was moved, so the venv's baked paths are stale. Run `rm -rf .venv && uv sync` from `backend/` to rebuild it. (See `docs/ERROR_FIX_LOG.md`.)

Then in Claude Code, run **`/task`** to pick up Group 2.

## What Group 2 looks like

**Group 2 — Data ingestion (CO — I-70 corridor focus area)** [[MVP4](docs/PRD.md)] has 8 subtasks. Every spatial layer is clipped to the 10 focus-area counties (Denver, Jefferson, Clear Creek, Gilpin, Park, Summit, Lake, Eagle, Garfield, Mesa — PRD §7.1). Per `docs/TASK_LIST.md`:

1. Ingest USGS national geologic map DB for CO
2. Ingest USGS MRDS records for CO
3. Ingest USGS USMIN records for CO
4. Ingest BLM land boundaries + claim layer (with as-of date stamp)
5. Ingest USFS forest boundaries
6. Ingest Colorado Geological Survey publications metadata + key spatial datasets
7. Build a refresh script (manual run; monthly cadence target for land status)
8. Document license + source for every ingested dataset

_Deferred to Phase 4: Texas Bureau of Economic Geology ingest (revive when Texas re-enters scope)._

Clipping to 10 counties cuts this well below a statewide pull, but it's still a sizable download — expect a multi-session effort. Realistic first session: get one dataset (USGS national geologic map, clipped to the focus-area counties) end-to-end — find the source, download, clip/parse, write a SQLAlchemy model, ingest into PostGIS, verify with a unit test. Once that pipeline is proven, the remaining datasets follow the same pattern.

## Carry-over open questions (from `docs/MEMO.md`)

- Specimen ID accuracy validation on Haiku 4.5 vision — needs a test set
- Haiku-vs-Sonnet escalation threshold — measure during eval
- PostGIS hosting if it ever leaves your laptop — defer
- CO dataset refresh automation — defer until manual refresh becomes friction

## Local-only branch leftover

`task/1-project-setup` is merged but still exists locally. Safe to delete:

```bash
git branch -d task/1-project-setup
```

Or leave it — it's harmless.
