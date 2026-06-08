"""Build a single-file offline trip bundle for the iOS field app (PRD 0001).

A *bundle* is one ``.pcbundle`` zip the desktop hands to the phone via AirDrop.
It is fully self-contained and offline — no auth, no cloud — and **user-agnostic**
(it carries no account/owner id), so it stays shareable if the app ever goes
multi-user. Contents:

  trip.json       — manifest: format/version, the trip + its waypoints, the
                    footprint bbox, the engine's scored areas over that footprint,
                    and basemap metadata.
  terrain.mbtiles — the shaded-relief basemap clipped to the trip footprint, so
                    the phone has an offline map of exactly the area it needs.

The footprint is the bounding box of the trip's waypoints, padded by a buffer
(~3 mi default). The basemap clip reuses the GDAL-in-Docker convention from the
ingest pipeline (no local GDAL install).
"""

from __future__ import annotations

import json
import math
import os
import shutil
import sqlite3
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from prospector.engine.scoring import score_area
from prospector.ingest.storage import PROCESSED_DIR, ensure_dir
from prospector.ingest.terrain import TILES_DIR, _container_path, _gdal

BUNDLE_FORMAT = "prospectors-compass.trip-bundle"
BUNDLE_VERSION = 1

# The desktop's baked shaded-relief basemap (built by `ingest basemap`).
HILLSHADE_MBTILES = TILES_DIR / "hillshade.mbtiles"
BASEMAP_NAME_IN_BUNDLE = "terrain.mbtiles"

# 1° latitude ≈ 69 miles. Longitude degrees-per-mile grows toward the poles, so
# the lon pad is scaled by 1/cos(lat). Rough but fine for padding a footprint.
MILES_PER_DEG_LAT = 69.0


def trip_footprint(
    waypoints: list[dict], buffer_mi: float
) -> tuple[float, float, float, float]:
    """Bounding box (minLon, minLat, maxLon, maxLat) of ``waypoints``, padded by
    ``buffer_mi`` on every side. Raises if there are no waypoints to bound."""
    pts = [(w["lon"], w["lat"]) for w in waypoints if "lon" in w and "lat" in w]
    if not pts:
        raise ValueError("trip has no located waypoints — cannot compute a footprint")
    lons = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    min_lon, max_lon = min(lons), max(lons)
    min_lat, max_lat = min(lats), max(lats)

    pad_lat = buffer_mi / MILES_PER_DEG_LAT
    mid_lat = (min_lat + max_lat) / 2.0
    # Guard the cosine so we never divide by ~0 at extreme latitudes.
    pad_lon = pad_lat / max(math.cos(math.radians(mid_lat)), 0.01)
    return (min_lon - pad_lon, min_lat - pad_lat, max_lon + pad_lon, max_lat + pad_lat)


def _read_mbtiles_meta(path: Path) -> dict:
    """Pull minzoom/maxzoom/format/bounds from an MBTiles metadata table."""
    meta: dict[str, str] = {}
    con = sqlite3.connect(str(path))
    try:
        for name, value in con.execute("SELECT name, value FROM metadata"):
            meta[name] = value
    finally:
        con.close()
    out: dict = {"format": meta.get("format"), "tile_size": 256}
    for key in ("minzoom", "maxzoom"):
        if key in meta:
            try:
                out[key] = int(meta[key])
            except (TypeError, ValueError):
                pass
    if "bounds" in meta:
        out["bounds"] = meta["bounds"]
    return out


def clip_basemap(bbox: tuple[float, float, float, float], out_path: Path) -> Path | None:
    """Clip the shaded-relief basemap to ``bbox`` (WGS84) into ``out_path`` (an
    MBTiles), with a small lower-zoom pyramid. Returns ``out_path``, or ``None``
    if the source basemap hasn't been built yet (bundle still works, just no map).

    ``out_path`` must live under the project root so the GDAL container can see it.
    """
    if not HILLSHADE_MBTILES.exists():
        return None
    min_lon, min_lat, max_lon, max_lat = bbox
    out_path.unlink(missing_ok=True)  # MBTILES driver won't overwrite
    # -projwin is (ulx, uly, lrx, lry); in lon/lat that's (minLon, maxLat, maxLon, minLat).
    _gdal(
        "gdal_translate", "-of", "MBTILES",
        "-projwin_srs", "EPSG:4326",
        "-projwin", str(min_lon), str(max_lat), str(max_lon), str(min_lat),
        _container_path(HILLSHADE_MBTILES), _container_path(out_path),
    )
    # Lower-zoom overviews so the phone can zoom out within the footprint. Average
    # resampling is correct for a shaded-relief *image* (matches the ingest build).
    _gdal("gdaladdo", "-r", "average", _container_path(out_path), "2", "4", "8")
    return out_path


def build_trip_bundle(
    trip_id: int,
    trip_name: str,
    waypoints: list[dict],
    target: str,
    buffer_mi: float = 3.0,
) -> Path:
    """Build a ``.pcbundle`` for one trip + engine target. Returns the path to the
    zip (a temp file the caller is responsible for cleaning up after sending)."""
    bbox = trip_footprint(waypoints, buffer_mi)
    # The desktop's deterministic engine, scored over the trip footprint. This is
    # the same call the desktop map uses — the phone just displays the result.
    scored = score_area(target, bbox)

    # Workspace under the project root so the GDAL container can mount the output.
    ensure_dir(PROCESSED_DIR)
    work_dir = Path(tempfile.mkdtemp(prefix="bundle_", dir=str(PROCESSED_DIR)))
    try:
        mbtiles_out = work_dir / BASEMAP_NAME_IN_BUNDLE
        basemap_path = clip_basemap(bbox, mbtiles_out)
        basemap_meta = (
            {"file": BASEMAP_NAME_IN_BUNDLE, **_read_mbtiles_meta(basemap_path)}
            if basemap_path
            else None
        )

        manifest = {
            "format": BUNDLE_FORMAT,
            "version": BUNDLE_VERSION,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "trip": {"id": trip_id, "name": trip_name, "waypoints": waypoints},
            "footprint": {"bbox": list(bbox), "buffer_mi": buffer_mi},
            "scored_areas": scored,
            "basemap": basemap_meta,
        }

        # Write the zip to a temp file (system temp dir, not the work dir — the
        # caller deletes it after the response). We only need mkstemp's unique
        # name; close its fd and let ZipFile('w') write/truncate that path.
        fd, zip_str = tempfile.mkstemp(prefix="trip_", suffix=".pcbundle")
        os.close(fd)
        zip_path = Path(zip_str)
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("trip.json", json.dumps(manifest, indent=2, ensure_ascii=False))
            if basemap_path:
                zf.write(basemap_path, BASEMAP_NAME_IN_BUNDLE)
        return zip_path
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
