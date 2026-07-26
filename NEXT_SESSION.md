# Next Session — Where We Left Off

_Last updated: 2026-06-12_

## State of the project

- **Branch:** `feat/mobile-field-app` (not merged to `main`). All recent work lives here.
- **Folder:** `/Users/harrisonvoegeli/Desktop/prospectors-compass` (moved out of the old
  `Unfinished-Projects/` path; the space in the name was also removed).
- **Current focus:** the **iOS mobile field app** (`mobile/`). The desktop research
  surface and the deterministic offline scoring engine are built and working; the active
  frontier is turning the phone from a read-only viewer into a real field companion.

This is offline-first, rule-based, no cloud AI in v1 (see `CLAUDE.md` and `docs/PRD.md`).

## What shipped this session (2026-06-12)

All committed on `feat/mobile-field-app`:

1. **`feat(layers)`** — hide low-information MRDS commodities ("General", "Metal") from the
   desktop "Looking for" dropdown; they still work as direct filter values.
2. **`assets(branding)`** — app icons (`.icns`, iOS/macOS 1024 px, `AppIcon.appiconset`),
   logos, and an alternate navy icon set, committed under `assets/branding/`.
3. **`feat(mobile)`** — the two field-app features below (E + F).
4. **`docs(mobile)`** — fixed `mobile/AGENTS.md` to point at the Expo **SDK 54** docs
   (it still said v56 after the downgrade).
5. **`fix(mobile)`** — aligned the mobile scored heat ramp to the desktop's Magma ramp
   (it was an amber ramp, perceptually inverted: high score read as dark, not bright).

**Verified live in the iOS simulator (2026-06-12):** clean build, the rationale card
(factors, +pts, the partial-gate `×0.5` math, and the land-status disclaimer), the
battery-conservative GPS picking up a new fix, center-on-me, and zoom gestures. The Magma
ramp was confirmed on-device. Note: in the simulator, pinch-zoom needs Option + drag (real
devices pinch normally); double-tap zooms in with one finger.

### E — Tap a scored cell for its rationale
Tapping any scored area on the phone now opens a card with the engine's factor-by-factor
breakdown (each factor's points, then the access gates shown as `×` multipliers) plus the
land-status gates and the mandated disclaimer. It mirrors the desktop's "factors add, then
gates multiply" math so the numbers stay honest even when a partial ownership gate
(state 0.5, private 0.2, federal 0.6) lowers the gated score. Implementation note: each
scored feature carries its source `idx` so the tap re-looks-up the full cell in memory
(the rich factors/gates objects don't survive the native press round-trip).

### F — Battery-conservative GPS
Idle tracking is now coarse and slow (`Balanced`, 25 m / 20 s) so the GPS chip can sleep
between fixes; `center-on-me` spends one fresh `High`-accuracy fix on demand. This replaces
the always-on `High` tracking that drained the battery on an all-day trip.

## Mobile roadmap (stated needs, sequenced)

Grounded in `docs/PRD.md` (MVP11 to MVP14), `docs/TASK_LIST.md` Phase 2 (§13 to §18), and
Flow B in `docs/USER_FLOW.md`. Done / next / after:

| Need | Source | Status |
|---|---|---|
| Offline MBTiles bundle + MapLibre Native render | §14 | Done |
| Desktop to phone handoff (`.pcbundle` export/AirDrop) | §17 | Done |
| Live GPS position on the map | §15 | Done |
| Planned waypoints visible + tap-to-fly | §15 | Done |
| Factor-by-factor rationale on the phone | MVP6 rule | **Done this session (E)** |
| Battery-conservative GPS while idle | §15 | **Done this session (F)** |
| **Find logging: drop a find at GPS with kind + note (+ photo)** | §15, Flow B | **NEXT** |
| Append-only sync of finds/waypoints back to desktop | §15, §17 | After (depends on find logging) |
| Waypoint navigation (bearing + distance) | §15 | Later |
| Non-AI specimen ID dichotomous key | §18, Phase 3 | Phase 3, its own effort |

**Recommended next step: find logging (H).** It is the keystone of the field surface and
the climax of Flow B ("user logs find with GPS + notes"). It turns the app from a viewer
into a capture tool. It needs a small local-persistence layer (write finds to the documents
directory as the trip's append-only log). Ship coordinates + note first, add the photo
attachment as a fast follow. Then round-trip those finds back to the desktop (needs the
desktop import side too).

**Designed out by offline-first (not pending debt):** magic-link auth, the network API
client, `/data/area-export`, and the in-field agent chat. The `.pcbundle` AirDrop path
replaced the networked sync; revisit only if a networked sync is ever wanted.

## To resume the mobile app

```bash
cd /Users/harrisonvoegeli/Desktop/prospectors-compass/mobile
npx tsc --noEmit          # fast sanity (expect clean)
npm run ios               # build + launch the iOS dev build in the simulator
```

The app loads a fixture bundle shipped as an asset (`mobile/assets/fixture.pcbundle`) so it
runs with no backend. In production the only line that changes is where the bundle comes
from (the OS hands us the opened AirDropped file). Pinned to **Expo SDK 54** /
React Native 0.81 / `@maplibre/maplibre-react-native` 11. Read the v54 Expo docs before
touching native config.

## To resume the desktop + backend (still works as before)

```bash
cd /Users/harrisonvoegeli/Desktop/prospectors-compass
docker compose up -d                         # postgres (host port 1776) + tileserver-gl (8080)
cd backend && uv run pytest                  # sanity
cd backend && uv run uvicorn prospector.main:app --port 8000
cd frontend && npm run dev                   # http://localhost:5173
```

- Postgres: `localhost:1776`, db/user/pwd all `prospector` (port is **1776**, not 5432).
- Repopulate data: `uv run python -m prospector.ingest all`.
- Rebuild a phone bundle from the desktop: use the "Export to phone" button (writes a
  `.pcbundle` of `trip.json` + clipped `terrain.mbtiles`).
- If `uv run pytest` fails to spawn after a move: `rm -rf .venv && uv sync` from `backend/`.
- If `uv run uvicorn …` fails with `Failed to spawn: uvicorn / No such file or directory`,
  the console script's shebang is stale — run it as a module instead:
  `uv run python -m uvicorn prospector.main:app --port 8000` (or rebuild: `rm -rf .venv && uv sync`).

## Run as a desktop app (Tauri shell — Phase 3a)

The frontend runs as a native desktop window via **Tauri** (Phase 1 added 2026-06-29 on
`feat/desktop-tauri-shell`; Phase 2 on `feat/desktop-phase2-backend-autolaunch`; Phase 3a on
`feat/desktop-phase3a-docker-autostart`). As of **Phase 3a the app starts the WHOLE local
stack itself** — Docker services (Postgres + tiles), then the FastAPI backend. You no longer
run `docker compose up -d` or `uvicorn` by hand; just launch the app. The only prerequisite
is that the **Docker daemon is running** (Docker Desktop / Colima).

```bash
cd /Users/harrisonvoegeli/Desktop/prospectors-compass/frontend
npm run tauri dev                            # DEV: starts Docker services + backend + window
npm run tauri build                          # RELEASE (bare): .app/.dmg that runs the stack from THIS repo/machine
npm run tauri:dist                           # DISTRIBUTABLE: self-contained fresh-machine .app/.dmg (bundles offline data)
```

**Two build flavors — pick by target machine:**

**1) `npm run tauri build` (bare, machine-local).** Produces a real double-clickable app with
the rounded logo icon, UI bundled as static files (no dev server), under
`frontend/src-tauri/target/release/bundle/`. It runs `docker compose` from the repo path baked
in at compile (`CARGO_MANIFEST_DIR`), so it only works on THIS Mac (repo + Docker present). No
offline data is bundled — smallest build, needs no pre-built `release/bundle`.

**2) `npm run tauri:dist` (fresh-machine distributable — Phase 3b, DONE 2026-07-25).** Same app,
but bundles the entire offline stack — the three Docker images (as tarballs), the seed DB, the
served tiles, and the slope raster — into `Contents/Resources/bundle/` (~1.8 GB `.app`/`.dmg`).
On a clean Mac with only Docker Desktop, first launch `docker load`s the images and Postgres
restores the seed automatically (see `lib.rs` → `ensure_images_loaded` / `stack_dir`). Prereq:
build the bundle first with `bash infra/packaging/make-seed.sh && bash infra/packaging/make-bundle.sh`
(needs the dev stack running). The `resources` wiring lives in `src-tauri/tauri.dist.conf.json`
(kept OUT of the base config so `tauri dev`/`tauri build` don't require the 1.8 GB `release/bundle`).

- **Do NOT double-click `target/debug/app`** — that's the raw dev binary: it shows a generic
  icon and loads the dev server (`:5173`), so clicked on its own it's blank. Use a release
  `.app`, or `npm run tauri dev`.
- Both release flavors find `docker` by absolute path (`/opt/homebrew/bin`, `/usr/local/bin`), so a
  Finder launch under a minimal `PATH` still starts the stack (`docker_bin()` in `lib.rs`).

- **Startup orchestration** lives in `frontend/src-tauri/src/lib.rs` (`run()` setup):
  1. `docker compose up -d` from the repo root (idempotent; brings up Postgres :1776 +
     tiles :8080). Requires the Docker daemon; if it's down, the app logs the error and
     loads anyway (data will be unavailable until Docker is up).
  2. waits for `:1776` and `:8080` to accept connections (only if the docker command
     succeeded, so a dead daemon doesn't freeze the window on dead ports).
  3. then the backend (below), then shows the UI.
  - Docker services are **left running on app exit** on purpose — they are persistent infra
    (`restart: unless-stopped`, with a data volume) shared with other dev work. To stop them
    yourself: `docker compose stop`.
- **Backend auto-launch** (Phase 2) also lives in `frontend/src-tauri/src/lib.rs`:
  - On startup the app checks `:8000`. If something is already listening (e.g. you started
    the backend in a terminal), it **uses that one** and won't double-start.
  - Otherwise it spawns `backend/.venv/bin/python -m uvicorn prospector.main:app --port 8000`
    (the venv Python directly, not `uv run`, so the child IS uvicorn — one clean process to
    kill, no PATH lookup). Requires `backend/.venv` to exist (`cd backend && uv sync`).
  - It then **waits up to 15s for `:8000` to answer** before showing the UI, because the
    frontend fetches with no retry and would otherwise flash "could not load".
  - On normal app close it kills the backend it started. A *force* kill (SIGKILL / Activity
    Monitor) can orphan the backend — the next launch detects it and reuses it, so it
    self-corrects. If you want a truly fresh backend: `pkill -f "uvicorn prospector"`.
- Requires the **Rust toolchain** (installed to `~/.cargo`; build-time only). If `cargo` is
  missing: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`.
- Tauri config: `frontend/src-tauri/tauri.conf.json` (window size, title, `devUrl` 5173,
  `frontendDist ../dist`, bundle id `com.harrisonvoegeli.prospectors-compass`).
- First `tauri dev` compiles the Rust shell (~35s); later launches are instant. Build
  artifacts live in `frontend/src-tauri/target/` (git-ignored).
- Uses macOS's built-in WebKit engine (not a bundled Chromium) — ~10MB app, no browser.
- **Phase 3b (not yet built):** package a distributable `.app` that runs on a fresh machine
  with no repo / Python / dev tools — bundle the Python backend AND ship PostGIS + tiles
  offline. This is a real architectural effort (the stack is locked to PostGIS, which does
  not embed easily); the current spawn/compose paths all assume the repo + `backend/.venv`
  + Docker are present on disk. Needs its own planning before coding. See chat history.

## Outstanding / parked

- **Subtask 8 — Anthropic console budget alerts.** N/A while v1 is offline (no API spend).
  Reinstate only if the optional AI layer is ever added.
- **Branding assets are ~12 MB of binaries** committed normally (not Git LFS) — fine at this
  scale; revisit only if they start to churn.
- Carry-over open questions live in `docs/MEMO.md`.
