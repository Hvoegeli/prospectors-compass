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

import httpx

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
    dem_3857 = PROCESSED_DIR / "dem_3857.tif"
    hillshade = PROCESSED_DIR / "hillshade.tif"
    mbtiles = TILES_DIR / "hillshade.mbtiles"
    mbtiles.unlink(missing_ok=True)  # MBTILES driver won't overwrite an existing file

    # 1. Mosaic the cells (explicit file list — no shell globbing in `docker run`).
    _gdal("gdalbuildvrt", _container_path(vrt), *(_container_path(p) for p in dem_paths))
    # 2. Reproject to web-mercator (MBTILES tiling expects EPSG:3857).
    _gdal("gdalwarp", "-t_srs", "EPSG:3857", "-r", "bilinear", "-overwrite",
          _container_path(vrt), _container_path(dem_3857))
    # 3. Shaded relief (multidirectional reads more naturally than a single light).
    _gdal("gdaldem", "hillshade", "-multidirectional", "-compute_edges",
          _container_path(dem_3857), _container_path(hillshade))
    # 4. Pack into MBTiles (base zoom) + 5. build the lower-zoom pyramid.
    _gdal("gdal_translate", "-of", "MBTILES", _container_path(hillshade), _container_path(mbtiles))
    _gdal("gdaladdo", "-r", "average", _container_path(mbtiles),
          "2", "4", "8", "16", "32", "64")

    log.info("Built hillshade basemap: %s", mbtiles)
    return str(mbtiles)
