# Installing Prospector's Compass (macOS)

The desktop app ships as a **self-contained `.dmg`**: it carries its own map data,
database seed, and services inside it, so it runs **fully offline** on a Mac that has
never seen this project. The only thing you must install yourself is **Docker Desktop**
(the app runs its Postgres/PostGIS, tile server, and backend as local Docker containers).

> **Apple Silicon only.** The build is `aarch64` (M-series Macs). It will not run on Intel Macs.

---

## For the person receiving the app

### 1. Install Docker Desktop (one time)

- Download from <https://www.docker.com/products/docker-desktop/> and install it.
- **Launch Docker Desktop and wait until it says "Running."** The app needs the Docker
  engine up before it can start its services. (If Docker isn't running when you open the
  app, you'll get a clear alert telling you to start it and reopen.)

### 2. Install the app

1. Double-click **`Prospector's Compass_<version>_aarch64.dmg`**.
2. Drag **Prospector's Compass** onto the **Applications** folder.
3. Eject the disk image.

### 3. First launch (one-time setup — be patient)

Open the app from Applications.

- Because the app isn't code-signed with an Apple Developer ID, macOS Gatekeeper will
  block the first open. **Right-click the app → Open → Open** (or
  System Settings → Privacy & Security → "Open Anyway"). You only do this once.
- On the **first** launch the app performs a one-time setup that takes **a minute or two**:
  - it loads its bundled Docker images (`docker load`), and
  - Postgres restores the bundled seed database.
  You'll get a macOS notification ("First-time setup: loading data…") while this happens.
  The map may be empty until setup finishes — give it a moment, it's not frozen.
- **Every launch after that is fast.** The images and database persist, so setup never
  re-runs.

### What "offline" means here

Once installed, the app needs **no internet**. All map layers, tiles, and the
recommendation engine run locally in Docker. Perfect for the backcountry where there's no
signal — set it up at home, use it in the field.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Alert: "Docker Desktop is required" | Docker Desktop isn't running. Start it, wait for "Running," reopen the app. |
| First launch shows an empty map for a while | Normal — the one-time image load + seed restore is still finishing. Wait 1–2 min. |
| Ports 8000 / 8080 / 1776 already in use | Another app (or a dev copy of this project) is using them. Quit it, or stop the other containers in Docker Desktop. |
| App won't open ("unidentified developer") | Right-click → Open → Open (unsigned build; one-time approval). |

---

## For the builder (producing the `.dmg`)

The distributable bundles ~1.8 GB of data, so it's built in three steps. The `release/`
output is git-ignored and fully reproducible from `infra/packaging/`.

**Prerequisites:** the dev stack running (`docker compose up -d` from the repo root) with
the three images built (`prospector-db:local`, `prospector-backend:local`,
`maptiler/tileserver-gl:latest`), plus the Rust toolchain (`~/.cargo/bin` on `PATH`).

```bash
# 1. Build the seed DB from the live dev database (compressed pg_dump).
bash infra/packaging/make-seed.sh

# 2. Assemble the ~1.8 GB offline bundle (image tarballs + seed + tiles + slope raster).
bash infra/packaging/make-bundle.sh

# 3. Build the distributable .app + .dmg (ships release/bundle as an app resource).
cd frontend
npm run tauri:dist
```

Output: `frontend/src-tauri/target/release/bundle/`
- `macos/Prospector's Compass.app`
- `dmg/Prospector's Compass_<version>_aarch64.dmg`  ← hand this to users

### Why a separate `tauri:dist` command?

The `resources` wiring that pulls `release/bundle` into the app lives in
`frontend/src-tauri/tauri.dist.conf.json`, **not** the base `tauri.conf.json`. Tauri
validates resource paths at compile time, so if that entry were in the base config, every
`tauri dev` / `tauri build` (and a fresh `git clone`, since `release/` is git-ignored)
would fail until you'd built the 1.8 GB bundle. Keeping it in a dist-only config means:

- `npm run tauri dev` / `npm run tauri build` — normal dev, **no bundle required**.
- `npm run tauri:dist` — the fat, self-contained distributable.

See `NEXT_SESSION.md` → "Run as a desktop app" for the two build flavors, and
`frontend/src-tauri/src/lib.rs` (`stack_dir`, `ensure_images_loaded`) for the first-run
provisioning logic.
