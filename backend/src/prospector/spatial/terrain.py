"""Slope and aspect at/around a point.

Samples the precomputed `slope.tif` / `aspect.tif` (derived from the 3DEP DEM by
`ingest.terrain.build_terrain_derivatives`) via the dockerized GDAL helper — no
Python raster binding required. Slope is in degrees; aspect is the downslope
compass direction (relevant for sun exposure / snow-off timing in the field).
"""

from __future__ import annotations

import math

from prospector.ingest.terrain import ASPECT_TIF, SLOPE_TIF, sample_raster

_COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
_M_PER_DEG_LAT = 111_320.0


def _compass(aspect_deg: float | None) -> str | None:
    # gdaldem marks flat cells with a negative aspect (-9999).
    if aspect_deg is None or aspect_deg < 0:
        return None
    return _COMPASS[round(aspect_deg / 45) % 8]


def slope_aspect_at(lon: float, lat: float) -> dict | None:
    """Slope (deg) and downslope aspect at the point.

    Returns ``{slope_deg, aspect_deg, aspect_compass}`` (aspect ``None`` on flat
    ground), or ``None`` if the point is outside the DEM coverage.
    """
    slope = sample_raster(SLOPE_TIF, [(lon, lat)])[0]
    if slope is None:
        return None
    aspect = sample_raster(ASPECT_TIF, [(lon, lat)])[0]
    flat = aspect is None or aspect < 0
    return {
        "slope_deg": round(slope, 1),
        "aspect_deg": None if flat else round(aspect, 1),
        "aspect_compass": _compass(aspect),
    }


def terrain_stats(lon: float, lat: float, radius_m: float, *, grid: int = 5) -> dict | None:
    """Mean/max slope over a small square window (≈ ``radius_m``) around the point.

    Samples a ``grid``×``grid`` lattice in a single GDAL call. Returns
    ``{mean_slope_deg, max_slope_deg, samples}`` or ``None`` if no sample lands on
    the DEM.
    """
    dlat = radius_m / _M_PER_DEG_LAT
    dlon = radius_m / (_M_PER_DEG_LAT * max(math.cos(math.radians(lat)), 0.01))
    points: list[tuple[float, float]] = []
    for i in range(grid):
        for j in range(grid):
            fy = (i / (grid - 1)) * 2 - 1 if grid > 1 else 0
            fx = (j / (grid - 1)) * 2 - 1 if grid > 1 else 0
            points.append((lon + fx * dlon, lat + fy * dlat))
    values = [v for v in sample_raster(SLOPE_TIF, points) if v is not None]
    if not values:
        return None
    return {
        "mean_slope_deg": round(sum(values) / len(values), 1),
        "max_slope_deg": round(max(values), 1),
        "samples": len(values),
    }
