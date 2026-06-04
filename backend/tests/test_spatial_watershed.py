"""Tests for the watershed lookup tool.

Skips when Postgres is unreachable or the watersheds layer isn't ingested.
"""

import pytest

from prospector.spatial.watershed import watershed_at


@pytest.fixture(scope="module")
def _watersheds_ready(require_table):
    require_table("watersheds")


def test_leadville_is_in_arkansas_headwaters(_watersheds_ready):
    """Leadville drains to the Arkansas — HUC region 11 (code starts '11')."""
    ws = watershed_at(-106.29, 39.25)
    assert ws is not None
    assert ws["huc12"] and ws["huc12"].startswith("11")
    assert ws["name"]


def test_breckenridge_is_in_upper_colorado(_watersheds_ready):
    """Breckenridge (Blue River) drains to the Colorado — HUC region 14."""
    ws = watershed_at(-106.04, 39.48)
    assert ws is not None
    assert ws["huc12"].startswith("14")


def test_point_outside_focus_area_returns_none(_watersheds_ready):
    assert watershed_at(-80.0, 25.0) is None  # Florida — outside the corridor
