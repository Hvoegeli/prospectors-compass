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

## Outstanding / parked

- **Subtask 8 — Anthropic console budget alerts.** N/A while v1 is offline (no API spend).
  Reinstate only if the optional AI layer is ever added.
- **Branding assets are ~12 MB of binaries** committed normally (not Git LFS) — fine at this
  scale; revisit only if they start to churn.
- Carry-over open questions live in `docs/MEMO.md`.
