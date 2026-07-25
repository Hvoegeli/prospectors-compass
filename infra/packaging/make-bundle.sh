#!/usr/bin/env bash
#
# make-bundle.sh — Phase 2 of the fresh-machine distributable.
#
# Assembles the fully self-contained OFFLINE bundle a clean Mac needs: the three
# Docker images (saved as tarballs so no registry/network is required), the seed
# DB, the served basemap tiles, the slope raster, and the distribution compose file.
#
# Output tree (git-ignored, ~2.5-3 GB) under release/bundle/:
#   docker-compose.yml                     (from docker-compose.dist.yml)
#   db-init/{01-extensions.sql,02-seed.sql.gz}   (from make-seed.sh)
#   tiles/{config.json,fonts/,hillshade.mbtiles} (ONLY what tileserver serves)
#   backend-data/processed/slope.tif             (placer-scoring raster)
#   images/{db,backend,tileserver}.tar.gz        (docker save | gzip)
#
# Prereq: run make-seed.sh first (needs the live dev DB). Images must be built
# locally (docker compose build) — this script only saves them.
set -euo pipefail

cd "$(dirname "$0")/../.."   # -> repo root
HERE="infra/packaging"
OUT="release/bundle"

# --- preflight -------------------------------------------------------------
if [ ! -f release/db-init/02-seed.sql.gz ]; then
  echo "ERROR: release/db-init/02-seed.sql.gz missing. Run: bash $HERE/make-seed.sh" >&2
  exit 1
fi
for img in prospector-db:local prospector-backend:local maptiler/tileserver-gl:latest; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "ERROR: image '$img' not found locally. Build the stack first (docker compose build / up)." >&2
    exit 1
  fi
done

mkdir -p "$OUT/tiles" "$OUT/backend-data/processed" "$OUT/images"

# --- 1) compose + seed -----------------------------------------------------
cp "$HERE/docker-compose.dist.yml" "$OUT/docker-compose.yml"
rm -rf "$OUT/db-init"; cp -R release/db-init "$OUT/db-init"

# --- 2) tiles: only what tileserver actually serves (config + fonts + hillshade)
cp tiles/config.json "$OUT/tiles/config.json"
rm -rf "$OUT/tiles/fonts"; cp -R tiles/fonts "$OUT/tiles/fonts"
cp tiles/hillshade.mbtiles "$OUT/tiles/hillshade.mbtiles"

# --- 3) slope raster (backend placer-scoring dependency) -------------------
cp backend/data/processed/slope.tif "$OUT/backend-data/processed/slope.tif"

# --- 4) images -> gzipped tarballs (offline, no registry needed) -----------
echo "==> Saving images (this is the slow part — ~3.6 GB across three images)…"
docker save prospector-db:local            | gzip > "$OUT/images/db.tar.gz"
echo "    db done"
docker save prospector-backend:local       | gzip > "$OUT/images/backend.tar.gz"
echo "    backend done"
docker save maptiler/tileserver-gl:latest  | gzip > "$OUT/images/tileserver.tar.gz"
echo "    tileserver done"

echo "==> Bundle assembled:"
du -sh "$OUT"
du -h "$OUT"/images/*.tar.gz "$OUT"/tiles/hillshade.mbtiles "$OUT"/db-init/02-seed.sql.gz "$OUT"/backend-data/processed/slope.tif
