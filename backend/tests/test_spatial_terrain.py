"""Tests for the slope/aspect terrain tool.

Skips when the slope/aspect rasters haven't been built (they're large, local,
git-ignored artifacts produced by `ingest basemap`). Requires Docker (the tool
samples via the GDAL container).
"""

import pytest

from prospector.ingest.terrain import SLOPE_TIF
from prospector.spatial.terrain import slope_aspect_at, terrain_stats


@pytest.fixture(scope="module")
def _rasters_ready():
    if not SLOPE_TIF.exists():
        pytest.skip("slope.tif not built — run `ingest basemap`")
    return True


# Arkansas River valley floor near Leadville (gentle) vs Mt Quandary flank (steep).
_VALLEY = (-106.29, 39.25)
_STEEP = (-106.10, 39.397)


def test_valley_is_gentler_than_mountainside(_rasters_ready):
    valley = slope_aspect_at(*_VALLEY)
    steep = slope_aspect_at(*_STEEP)
    assert valley is not None and steep is not None
    assert valley["slope_deg"] < steep["slope_deg"]
    assert steep["slope_deg"] > 10  # a real mountain flank


def test_aspect_compass_is_cardinal_or_none(_rasters_ready):
    a = slope_aspect_at(*_STEEP)
    assert a["aspect_compass"] in {"N", "NE", "E", "SE", "S", "SW", "W", "NW", None}


def test_terrain_stats_window(_rasters_ready):
    stats = terrain_stats(*_STEEP, 500)
    assert stats is not None
    assert stats["samples"] > 0
    assert stats["max_slope_deg"] >= stats["mean_slope_deg"]


def test_point_outside_dem_returns_none(_rasters_ready):
    assert slope_aspect_at(-80.0, 25.0) is None  # Florida — outside DEM coverage
