# Next Session — Where We Left Off

_Last session: 2026-05-05_

## State of the project

- **Branch:** `main`, synced with `origin/main` (commit `e4eefed`).
- **Group 1 (Project setup):** 7 of 8 subtasks complete and merged.
- **Group 2 (Data ingestion CO + TX):** not started.

## What's running locally

You may have left these up between sessions — re-check before starting:

```bash
docker compose ps                # is the postgres container still healthy?
docker compose up -d             # bring it back up if stopped
```

Postgres is at `localhost:5432`, db `prospector`, user `prospector`, pwd `prospector`. Both PostGIS 3.4.3 and pgvector 0.8.2 are loaded.

## Deferred from last session

- **Subtask 8 — Anthropic console budget alerts.** Manual web action.
  - Go to console.anthropic.com → Settings → Limits.
  - Set hard cap **$8** and alert at **$5**.
  - Then check the box in `docs/TASK_LIST.md` group 1.

## To resume

```bash
cd /Users/harrisonvoegeli/projects/prospectors-compass
docker compose up -d                       # postgres
cd backend && uv run pytest                # sanity (expect 10/10 green)
```

Then in Claude Code, run **`/task`** to pick up Group 2.

## What Group 2 looks like

**Group 2 — Data ingestion (CO + TX)** [[MVP4](docs/PRD.md)] has 9 subtasks. Per `docs/TASK_LIST.md`:

1. Ingest USGS national geologic map DB for CO and TX
2. Ingest USGS MRDS records for CO and TX
3. Ingest USGS USMIN records for CO and TX
4. Ingest BLM land boundaries + claim layer (with as-of date stamp)
5. Ingest USFS forest boundaries
6. Ingest Colorado Geological Survey publications metadata + key spatial datasets
7. Ingest Texas Bureau of Economic Geology atlas + mineral resources data
8. Build a refresh script (manual run; monthly cadence target for land status)
9. Document license + source for every ingested dataset

This is **multi-GB of data** to download. Expect a multi-session effort. Realistic first session: get one dataset (USGS national geologic map for CO) end-to-end — find the source, download, parse, write a SQLAlchemy model, ingest into PostGIS, verify with a unit test. Once that pipeline is proven, the remaining datasets follow the same pattern.

## Carry-over open questions (from `docs/MEMO.md`)

- Specimen ID accuracy validation on Haiku 4.5 vision — needs a test set
- Haiku-vs-Sonnet escalation threshold — measure during eval
- PostGIS hosting if it ever leaves your laptop — defer
- CO + TX dataset refresh automation — defer until manual refresh becomes friction

## Local-only branch leftover

`task/1-project-setup` is merged but still exists locally. Safe to delete:

```bash
git branch -d task/1-project-setup
```

Or leave it — it's harmless.
