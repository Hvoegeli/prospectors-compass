#!/usr/bin/env bash
#
# make-seed.sh — Phase 1 of the fresh-machine distributable.
#
# Builds the SEED database: a compressed pg_dump of the locally-built PostGIS DB
# that a brand-new machine restores automatically on first launch. Postgres runs
# anything in /docker-entrypoint-initdb.d ONLY when the data volume is first
# created, so dropping the dump there makes first-run restore automatic and
# idempotent (it never re-runs on later launches).
#
# Output (git-ignored, multi-hundred-MB): release/db-init/
#   01-extensions.sql   — creates postgis + vector (copied from infra/db/init)
#   02-seed.sql.gz      — schema + data for every app table
#
# WHY TWO TABLES ARE EXCLUDED (data only — the tables themselves still restore):
#   * contour_lines   — 2.96M rows / ~2.8 GB, i.e. ~90% of the DB. It's a deep-zoom
#                       (z>=11) nicety; excluding its DATA keeps the empty table so
#                       the contours toggle degrades to "no lines" instead of erroring
#                       on a missing table. This is the single biggest size lever.
#   * spatial_ref_sys — PostGIS repopulates this (8.5k coordinate systems) when
#                       01-extensions.sql creates the extension. Restoring the dump's
#                       copy too would collide on the srid primary key.
#
# Requires: the dev stack running (docker compose up -d) so prospector-db is live.
set -euo pipefail

cd "$(dirname "$0")/../.."   # -> repo root
OUT="release/db-init"
CONTAINER="prospector-db"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "ERROR: $CONTAINER is not running. Start the stack first: docker compose up -d" >&2
  exit 1
fi

mkdir -p "$OUT"

# 1) Extensions run first on a fresh volume (must sort before the seed).
cp infra/db/init/01-extensions.sql "$OUT/01-extensions.sql"

# 2) Schema + data for everything else. Dumped from INSIDE the container so the
#    pg_dump version matches the server (PG16). --no-owner/--no-privileges keeps the
#    restore portable across the identical distribution role.
echo "==> Dumping seed (excluding contour_lines + spatial_ref_sys data)…"
docker exec "$CONTAINER" pg_dump -U prospector -d prospector \
  --no-owner --no-privileges \
  --exclude-table-data=contour_lines \
  --exclude-table-data=spatial_ref_sys \
  | gzip -9 > "$OUT/02-seed.sql.gz"

echo "==> Seed built:"
du -h "$OUT/01-extensions.sql" "$OUT/02-seed.sql.gz"
