# PRD 0001: Prospector's Compass — Field (iOS)

- **Status:** Draft
- **Author:** Harrison Voegeli
- **Created:** 2026-06-08

## Summary

An offline-first iOS field companion that carries a planned trip's terrain map, the desktop's scored prospecting areas, and waypoints into the backcountry — with native GPS position tracking and on-site find logging — requiring no cell signal, while opportunistically using connectivity when it happens to be available.

## Problem

Prospecting happens in the backcountry, where there is no cell service. All the research and the engine's recommended ground live in the desktop app, so once a prospector is on-site they cannot tell where the recommended ground is relative to where they are standing, cannot navigate toward it, and cannot capture a find at the exact spot. The pain is the disconnect between desktop research and on-the-ground action — felt by the field user (initially the author; a single user, single device in v1).

## Goals / Success Criteria

Observable, demonstrable signals:

1. **Airplane-mode end-to-end run.** With the phone in airplane mode: import a desktop-exported trip, the offline terrain map renders, the scored areas and waypoints display, the GPS dot tracks the user's position, and a find pin (auto GPS coordinates + photo + notes + material/amount) can be dropped and persists across app restarts.
2. **Field-verified GPS accuracy.** Standing in the field, the user can see their position relative to a recommended spot and walk toward it; finds logged on-site land at the correct coordinates.
3. **Full round-trip.** A desktop-exported bundle imports and is usable offline; field-captured finds and waypoints export back as an append-only field-log file that the desktop merges into the trip.

## Non-goals

- Replacing the desktop research tool — the phone is a field companion; discovery and scoring stay on the desktop.

## Scope

### In scope (minimum cut that ships — the full v1 loop)

- Import a desktop trip bundle: a **single package file** containing the offline MBTiles + a `trip.json` (scored areas, waypoints, notes).
- Offline, pannable **MapLibre Native** terrain map rendered from the bundled MBTiles.
- Display the desktop's **scored prospecting areas** and **waypoints** from the bundle.
- **Live GPS position tracking** via the device's GPS receiver — works in airplane mode; uses connectivity opportunistically (faster first fix) when present, never requires it.
- **Find logging** in the field, capturing: auto-stamped GPS coordinates, photo(s), free-text notes, and material/category + rough amount.
- **Drop waypoints** in the field.
- **Export an append-only field-log file** (new finds + waypoints only) to AirDrop back to the desktop.
- **Desktop side (included in this PRD):** bundle-export (build the single package from a trip) and field-log import/merge (append-only).

### Out of scope

- Auth / accounts / cloud sync (sync is file/AirDrop only).
- On-device scoring or recomputation — the phone displays exported results only; it never runs the engine.
- Trip-*plan* authoring on the phone — the desktop plans; the phone consumes the bundle. (Field find/waypoint *capture* is the exception and is in scope.)
- Android (iOS only for v1).
- Turn-by-turn navigation / routing.
- Real-time desktop↔phone sync.
- Sharing / multi-user / social features.

## Proposed Design

### New services / components

**Phone (React Native + Expo dev build, iOS):**
- **Bundle import/unpack** — receives the single package file (via iOS "Open in" / AirDrop / share sheet), extracts the MBTiles and `trip.json` into app storage.
- **Offline map view** — MapLibre Native (`@maplibre/maplibre-react-native`) rendering the local MBTiles, with overlays for scored areas, waypoints, and find pins.
- **Location service** — `expo-location`; live position, airplane-mode capable; surfaces position relative to recommended spots (bearing + distance).
- **Find-logging flow** — form capturing auto-coordinates, photo(s) (`expo-image-picker`), notes, and material/amount; persisted locally.
- **Waypoint drop** — tap-to-place waypoints with the current or chosen location.
- **Field-log export** — serializes new finds + waypoints to an append-only field-log file; `expo-file-system` + `expo-sharing` for AirDrop.
- **Local trip store** — JSON or `expo-sqlite` for the imported trip + field captures.

**Desktop (existing `frontend/` + `backend/`):**
- **Bundle-export** — builds the single package: clip/select the per-trip MBTiles footprint and serialize scored areas/waypoints/notes to `trip.json`, zip into one file. New backend endpoint (e.g. `POST /trips/{id}/export-bundle`) + a frontend "Export to phone" control. (Relates to the task list's `/data/area-export`.)
- **Field-log import/merge** — ingests the returned append-only field-log and merges finds/waypoints into the trip (append-only; last-write-wins on metadata, per the recorded sync model).

### Existing code touched

- **Desktop frontend** (`frontend/src/MapView.tsx` trip UI) — add export-to-phone and field-log-import controls.
- **Backend** (`backend/src/prospector/api/trips.py` + a new export/import module) — bundle build + field-log merge.
- **Tile pipeline** (`tiles/`) — per-trip footprint extraction (~3 mi buffer, z10–z15 per recorded defaults) into the bundle's MBTiles.
- **DB models** (`backend/src/prospector/db/models.py`) — ensure finds and field-captured waypoints are representable.

### Data model changes

- **Bundle package schema** — container holding `trip.json` (scored areas as grid/GeoJSON with score/band/factor snapshot, waypoints, notes) + the per-trip `.mbtiles`.
- **Field-log file schema** — append-only list of finds (coordinates, photo references, notes, material, amount, timestamp, client id) + waypoints.
- **Phone-local store** — schema for the imported trip plus field captures.
- **Desktop** — a `finds` table/columns if not already present; waypoints able to carry a field-captured origin.

### External dependencies

- React Native + **Expo (dev build, not Expo Go)**, **`@maplibre/maplibre-react-native`**, `expo-location` (GPS), `expo-file-system` + `expo-sharing` (bundle import + AirDrop export), `expo-image-picker` (find photos), local store (`expo-sqlite` or JSON). iOS only.

## Open questions

- What exactly should "online / opportunistic connectivity" add, given GPS works fully offline? (Faster first fix via assisted-GPS? Live data refresh? Define the concrete benefit.)
- Confirm tile footprint defaults: ~3 mi buffer, zoom z10–z15 (Standard), adjustable at export time.
- Photo storage: embed photos in the package/field-log vs. reference the device photo library; size limits for AirDrop transfer.
- Field-log merge semantics on the desktop: precise append-only + last-write-wins-on-metadata rules; duplicate detection.
- Bundle container format (`.zip` vs a custom `.pcz` extension) and how iOS hands the file to the app (file-type association / share extension).
- Field navigation UX: exact affordance for "bearing + distance to a recommended spot."
- **Forward-looking (future multi-user):** keep the bundle and field-log formats **portable and not user-locked**, so that if the app ever becomes public/multi-user, one person can build a plan, bundle it, and hand it to a *different* user who can open and use it without an account tying it to the creator. (v1 is single-user/no-auth, so bundles are already user-agnostic — this is about not introducing a user-id dependency that would break that property later.)

## References

- `docs/PRD.md` — overall product PRD
- `docs/TASK_LIST.md` — Phase 2 (Groups 13–17: mobile shell, offline maps, GPS + waypoints + find-pins, trip sync)
- `mockups/phone-app-mockup.html` — existing phone UI mockup
- `CLAUDE.md` — tech-stack lock (Expo dev build, MapLibre Native, iOS-only, offline-first)
