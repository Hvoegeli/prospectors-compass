"""Build a self-hosted hillshade basemap (MBTiles) for the focus area.

Pipeline, region-parameterized like the other ingesters:
  1. Compute the 1°×1° USGS 3DEP DEM cells covering the region's county bbox.
  2. Download each cell (keyless, public-domain) from the TNM AWS staged bucket.
  3. Mosaic → reproject to web-mercator → hillshade → MBTiles → zoom overviews,
     running GDAL through the `osgeo/gdal` Docker image (no local GDAL install).
  4. Output ``tiles/hillshade.mbtiles`` (git-ignored), served by TileServer GL.

This honours the localized-download model: the .mbtiles is per-region and lives
on the machine that built it. The shaded-relief basemap is the terrain a
prospector reads (drainages, ridges) under our vector overlays.

Source: USGS 3DEP 1 arc-second DEM. License: public domain (US Gov work).
"""

from __future__ import annotations

import logging
import math
import subprocess

import geopandas as gpd
import httpx
from sqlalchemy import text

from prospector.db.base import engine
from prospector.ingest.census import load_region_counties
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.storage import (
    BACKEND_ROOT,
    PROCESSED_DIR,
    RAW_DIR,
    download_file,
    ensure_dir,
)

log = logging.getLogger(__name__)

PROJECT_ROOT = BACKEND_ROOT.parent
TILES_DIR = PROJECT_ROOT / "tiles"
DEM_DIR = RAW_DIR / "dem"

# Terrain raster products (web-mercator), produced by build_basemap.
DEM_3857 = PROCESSED_DIR / "dem_3857.tif"
SLOPE_TIF = PROCESSED_DIR / "slope.tif"
ASPECT_TIF = PROCESSED_DIR / "aspect.tif"

# Contour lines, traced from the DEM by build_contours.
CONTOURS_GPKG = PROCESSED_DIR / "contours.gpkg"
CONTOUR_TABLE = "contour_lines"
# US-style contours: a line every 40 ft, every 5th (200 ft) an "index" contour
# (drawn heavier + labeled). The DEM's elevation is in METRES, and gdal_contour's
# interval is in those z-units, so we convert: 40 ft = 12.192 m.
FT_PER_M = 3.28084
CONTOUR_INTERVAL_FT = 40
INDEX_INTERVAL_FT = 200

# OSGeo's official GDAL image (the small Ubuntu build has all the CLI tools).
GDAL_IMAGE = "ghcr.io/osgeo/gdal:ubuntu-small-latest"

# TNM staged 1 arc-second GeoTIFF, named by the cell's NW corner (e.g. n40w107).
DEM_URL = (
    "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/current/"
    "{cell}/USGS_1_{cell}.tif"
)


def dem_cells(bbox: tuple[float, float, float, float]) -> list[str]:
    """1° DEM cell names (``n{NN}w{WWW}``) covering ``bbox`` = (minx,miny,maxx,maxy).

    USGS names each 1°×1° tile by its NW corner: cell ``nNN`` spans latitude
    [NN-1, NN]; cell ``wWWW`` spans longitude [-WWW, -WWW+1]. So to cover a bbox
    we take every integer north from ceil(miny)..ceil(maxy) and every integer
    west from ceil(-maxx)..ceil(-minx).
    """
    minx, miny, maxx, maxy = bbox
    norths = range(math.ceil(miny), math.ceil(maxy) + 1)
    wests = range(math.ceil(-maxx), math.ceil(-minx) + 1)
    return [f"n{n:02d}w{w:03d}" for n in norths for w in wests]


def _container_path(path) -> str:
    """Map a host path under the project root to its path inside the GDAL container."""
    return f"/work/{path.relative_to(PROJECT_ROOT).as_posix()}"


def _gdal(*args: str) -> None:
    """Run one GDAL command inside the osgeo/gdal container (project root → /work)."""
    cmd = [
        "docker", "run", "--rm",
        "-v", f"{PROJECT_ROOT}:/work",
        GDAL_IMAGE,
        *args,
    ]
    log.info("gdal: %s", " ".join(args))
    subprocess.run(cmd, check=True)


def download_region_dem(region: DownloadRegion = DEFAULT_REGION) -> list:
    """Download the DEM cells covering ``region``; return the local .tif paths."""
    counties = load_region_counties(region)
    cells = dem_cells(tuple(counties.total_bounds))
    log.info("DEM cells for region '%s': %d (%s)", region.name, len(cells), ", ".join(cells))

    paths = []
    for cell in cells:
        dest = DEM_DIR / f"USGS_1_{cell}.tif"
        try:
            paths.append(download_file(DEM_URL.format(cell=cell), dest))
        except httpx.HTTPStatusError as exc:
            # Not every 1° cell exists (e.g. all-ocean); skip and log.
            log.warning("DEM cell %s unavailable (%s) — skipping", cell, exc.response.status_code)
    if not paths:
        raise RuntimeError("No DEM cells downloaded — cannot build the basemap.")
    return paths


def build_basemap(region: DownloadRegion = DEFAULT_REGION) -> str:
    """Download DEM + build ``tiles/hillshade.mbtiles`` via the GDAL container.

    Idempotent: overwrites the output mbtiles. Returns the output path.
    """
    dem_paths = download_region_dem(region)
    ensure_dir(PROCESSED_DIR)
    ensure_dir(TILES_DIR)

    vrt = PROCESSED_DIR / "dem.vrt"
    hillshade = PROCESSED_DIR / "hillshade.tif"
    mbtiles = TILES_DIR / "hillshade.mbtiles"
    mbtiles.unlink(missing_ok=True)  # MBTILES driver won't overwrite an existing file

    # 1. Mosaic the cells (explicit file list — no shell globbing in `docker run`).
    _gdal("gdalbuildvrt", _container_path(vrt), *(_container_path(p) for p in dem_paths))
    # 2. Reproject to web-mercator (MBTILES tiling expects EPSG:3857).
    _gdal("gdalwarp", "-t_srs", "EPSG:3857", "-r", "bilinear", "-overwrite",
          _container_path(vrt), _container_path(DEM_3857))
    # 3. Shaded relief (multidirectional reads more naturally than a single light).
    _gdal("gdaldem", "hillshade", "-multidirectional", "-compute_edges",
          _container_path(DEM_3857), _container_path(hillshade))
    # 4. Pack into MBTiles (base zoom) + 5. build the lower-zoom pyramid.
    _gdal("gdal_translate", "-of", "MBTILES", _container_path(hillshade), _container_path(mbtiles))
    _gdal("gdaladdo", "-r", "average", _container_path(mbtiles),
          "2", "4", "8", "16", "32", "64")

    # 6. Terrain analysis rasters for the slope/aspect spatial tool.
    build_terrain_derivatives()

    log.info("Built hillshade basemap: %s", mbtiles)
    return str(mbtiles)


def build_terrain_derivatives() -> tuple[str, str]:
    """Derive slope + aspect rasters (degrees) from the reprojected DEM.

    Cheap follow-on to ``build_basemap`` (operates on the existing
    ``dem_3857.tif``). Returns the (slope, aspect) paths. Slope is in degrees;
    note web-mercator slightly exaggerates slope away from the equator —
    acceptable for "how steep, roughly" prospecting use.
    """
    if not DEM_3857.exists():
        raise RuntimeError(f"{DEM_3857} missing — run `ingest basemap` first.")
    # DEFLATE + float predictor keeps these ~1GB-uncompressed rasters small on disk.
    co = ["-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3"]
    _gdal("gdaldem", "slope", "-compute_edges", _container_path(DEM_3857), _container_path(SLOPE_TIF), *co)
    _gdal("gdaldem", "aspect", "-compute_edges", _container_path(DEM_3857), _container_path(ASPECT_TIF), *co)
    log.info("Built terrain derivatives: %s, %s", SLOPE_TIF, ASPECT_TIF)
    return str(SLOPE_TIF), str(ASPECT_TIF)


def build_contours(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Trace elevation contour lines from the DEM and load them into PostGIS.

    Uses ``gdal_contour`` on the reprojected ``dem_3857.tif`` (built by
    ``build_basemap``) at a 40 ft interval, tags each line with its elevation in
    feet and whether it's a 200 ft index contour, and bulk-loads the result into
    the ``contour_lines`` table (served by the generic ``/layers`` endpoint).

    Idempotent: replaces the table each run. Returns the number of contour lines.
    Note ``region`` is accepted for CLI symmetry; the contours come from whatever
    DEM extent ``build_basemap`` produced for that region.
    """
    if not DEM_3857.exists():
        raise RuntimeError(f"{DEM_3857} missing — run `ingest basemap` first.")

    interval_m = CONTOUR_INTERVAL_FT / FT_PER_M  # 40 ft → 12.192 m
    CONTOURS_GPKG.unlink(missing_ok=True)  # gdal_contour won't overwrite
    # Trace isolines; -a writes the contour's elevation (raster z = metres) onto
    # each feature as `elev_m`. Output a GeoPackage of LineStrings (EPSG:3857).
    _gdal(
        "gdal_contour", "-a", "elev_m", "-i", f"{interval_m:.6f}",
        _container_path(DEM_3857), _container_path(CONTOURS_GPKG),
    )

    # Reproject to WGS84 (the SRID every other layer + the bbox filter use),
    # derive feet + the index flag, and bulk-load. to_postgis is used instead of
    # the row-by-row ORM inserts elsewhere because this is hundreds of thousands
    # of lines — an ORM loop would be far too slow.
    gdf = gpd.read_file(CONTOURS_GPKG).to_crs(4326)
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()
    gdf["elev_ft"] = (gdf["elev_m"] * FT_PER_M).round().astype(int)
    gdf["is_index"] = gdf["elev_ft"] % INDEX_INTERVAL_FT == 0
    gdf = gdf[["elev_ft", "is_index", "geometry"]].rename_geometry("geom")

    gdf.to_postgis(CONTOUR_TABLE, engine, if_exists="replace", index=False)
    # Subdivide long lines into small pieces (≤128 vertices) so each row has a tight
    # bounding box. A single contour can wind for miles; left whole, its bbox spans
    # the region and a viewport query pulls thousands of huge geometries (slow /
    # Postgres OOM). Subdividing makes the spatial index selective and per-row clips
    # cheap. ST_Subdivide is a set-returning fn — it expands each line into N rows.
    with engine.begin() as conn:
        conn.execute(text(f"DROP TABLE IF EXISTS {CONTOUR_TABLE}_sub"))
        conn.execute(text(
            f"CREATE TABLE {CONTOUR_TABLE}_sub AS "
            f"SELECT elev_ft, is_index, ST_Subdivide(geom, 128) AS geom FROM {CONTOUR_TABLE}"
        ))
        conn.execute(text(f"DROP TABLE {CONTOUR_TABLE}"))
        conn.execute(text(f"ALTER TABLE {CONTOUR_TABLE}_sub RENAME TO {CONTOUR_TABLE}"))
        # The /layers viewport query (ST_Intersects + ST_ClipByBox2D) needs this.
        conn.execute(text(
            f"CREATE INDEX {CONTOUR_TABLE}_geom_gix ON {CONTOUR_TABLE} USING GIST (geom)"
        ))
        count = conn.execute(text(f"SELECT count(*) FROM {CONTOUR_TABLE}")).scalar_one()

    log.info("Built %d contour pieces (%d ft / %d ft index) for region '%s'",
             count, CONTOUR_INTERVAL_FT, INDEX_INTERVAL_FT, region.name)
    return count


def sample_raster(raster_path, points: list[tuple[float, float]]) -> list[float | None]:
    """Sample a raster at WGS84 (lon, lat) points via dockerized ``gdallocationinfo``.

    One container handles all points (coords piped on stdin). Returns one value
    per point in order; ``None`` for points outside the raster. Reuses the
    GDAL Docker image so no Python raster binding is needed.
    """
    if not points:
        return []
    if not raster_path.exists():
        return [None] * len(points)
    stdin = "\n".join(f"{lon} {lat}" for lon, lat in points) + "\n"
    cmd = [
        "docker", "run", "--rm", "-i",
        "-v", f"{PROJECT_ROOT}:/work",
        GDAL_IMAGE,
        "gdallocationinfo", "-valonly", "-l_srs", "EPSG:4326",
        _container_path(raster_path),
    ]
    # No check=True: gdallocationinfo exits non-zero for points off the raster
    # extent — that's expected (→ None), not an error. Values map to points by
    # line index; in practice points are either all in-coverage or all out.
    result = subprocess.run(cmd, input=stdin, capture_output=True, text=True)  # noqa: S603
    lines = result.stdout.splitlines()
    values: list[float | None] = []
    for i in range(len(points)):
        line = lines[i].strip() if i < len(lines) else ""
        try:
            values.append(float(line) if line else None)
        except ValueError:
            values.append(None)
    return values
