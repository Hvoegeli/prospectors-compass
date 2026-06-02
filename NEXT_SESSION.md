# Next Session — Where We Left Off

_Last updated: 2026-06-01_

## State of the project

- **Branch:** `task/2-data-ingestion-co` (Group 2 in progress; **not merged to `main`**). The scope-change branch was already merged (`main` is at `1e809fe`).
- **Group 1 (Project setup):** complete except subtask 8 (Anthropic budget alerts — manual web action, see below).
- **Group 2 (Data ingestion):** 4 of the planned layers done and committed, all with passing integration tests:
  | Layer | Table | Records | Source |
  |---|---|---|---|
  | County clip mask | `counties` | 10 | Census cartographic boundaries |
  | MRDS mines | `mrds_sites` | 4,398 | USGS MRDS (national CSV) |
  | USMIN topo features | `usmin_features` | 12,763 | USGS USMIN (per-state) |
  | Geologic units | `geologic_units` | 1,697 | USGS SGMC (per-state) |

  Ingestion engine: `backend/src/prospector/ingest/` — region-parameterized around `DownloadRegion` (state + counties; v1 default = `I70_CORRIDOR`). Run via `uv run python -m prospector.ingest {counties|mrds|usmin|geology|all}`. All downloaded data is local/gitignored.

## Next up — BLM land status (subtask 4), then a desktop map slice

Decided sequencing: finish core Group 2 data (BLM = **both** ownership + claims), **then** build a minimal MapLibre desktop map showing all layers (also serves as visual ingestion QA). **USFS (subtask 5) and CGS (subtask 6) are intentionally deferred** until after the map slice.

**BLM ownership half is fully scoped + downloaded + validated, ready to build:**
- Source: **USGS PAD-US 4.1** (deliberate substitution for BLM's fiddly ArcGIS — surfaced + approved). Per-state, region-parameterizable URL: `https://www.sciencebase.gov/catalog/file/get/6759abcfd34edfeb8710a004?name=PADUS4_1_State_{ABBREV}_GDB_KMZ.zip`. CO file (168 MB) already downloaded + extracted to `backend/data/raw/padus/PADUS4_1_StateCO.gdb`.
- **Use the `PADUS4_1Fee_State_{ABBREV}` layer** (validated: by AREA it's USFS 14.5M ac + BLM 8.45M ac — the right layer; the "Combined" layer is overlapping/messier, not needed).
- CRS is Albers (ESRI:102039) → **reproject to 4326**. Build like geology (polygon clip-to-union of focus-area counties).
- Fields to keep (use the decoded `d_` versions): `d_Mang_Name`, `d_Mang_Type`, `d_Own_Type`, `Unit_Nm`, `d_Pub_Access`, and `Src_Date` (→ the mandatory **as-of date stamp**).

**BLM claims half — NOT yet sourced.** Only BLM has claims (PAD-US doesn't). PRD flags this data as "messy/lagging." Needs a source hunt (likely BLM MLRS / ArcGIS) + as-of stamping. Treat as its own unit.

## Earlier scope cuts (still in force)

1. **Texas dropped from v1 → Phase 4** (data/eval/examples preserved as "deferred" notes).
2. **Colorado narrowed to the I-70 corridor** — 10 counties, defined canonically in PRD §7.1.

## What's running locally

You may have left these up between sessions — re-check before starting:

```bash
docker compose ps                # is the postgres container still healthy?
docker compose up -d             # bring it back up if stopped
```

Postgres is at `localhost:1776`, db `prospector`, user `prospector`, pwd `prospector`. Both PostGIS 3.4.3 and pgvector 0.8.2 are loaded.

> **Port note (2026-06-01):** Host port is **1776**, not 5432 — 5432 was already taken by another project's container + an ssh tunnel on this machine. The container still speaks 5432 internally; `docker-compose.yml`, `.env`, and `config.py` are all set to 1776.

## Still to do / outstanding

- **Subtask 8 — Anthropic console budget alerts.** Manual web action (carried over).
  - Go to console.anthropic.com → Settings → Limits.
  - Set hard cap **$8** and alert at **$5**.
  - Then check the box in `docs/TASK_LIST.md` group 1.
- **Region selector sub-regions (deferred, implementation-level).** The `state: "CO"` API field in `docs/USER_FLOW.md` was left as-is. If the selector should pick *sub-regions within* the corridor (vs. one CO region), spec it when building Group 7 (recommendation engine / selector UI). No action needed now.

## To resume

```bash
cd "/Users/harrisonvoegeli/Desktop/projects/Unfinished Projects/prospectors-compass"
docker compose up -d                       # postgres (host port 1776)
cd backend && uv run pytest                # sanity (expect 27 green)
```

> **If `uv run pytest` fails to spawn:** the project was moved, so the venv's baked paths are stale. Run `rm -rf .venv && uv sync` from `backend/` to rebuild it. (See `docs/ERROR_FIX_LOG.md`.)
>
> Integration tests skip if their data isn't ingested. To repopulate the DB: `uv run python -m prospector.ingest all`.

Then continue with **BLM land status** — see "Next up" above for the fully-scoped PAD-US ownership build, then the claims half.

_Group 2 remaining per `docs/TASK_LIST.md`: subtask 4 (BLM, in progress), 5 (USFS, deferred), 6 (CGS, deferred), 7 (refresh script), 8 (license docs — ongoing in `docs/DATA_SOURCES.md`)._

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
