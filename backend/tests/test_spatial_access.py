"""Tests for the distance-from-road / accessibility spatial tools.

Skips when Postgres is unreachable or the roads layer isn't ingested.
"""

import pytest

from prospector.spatial.access import accessibility, nearest_road


@pytest.fixture(scope="module")
def _roads_ready(require_table):
    require_table("roads")


# Idaho Springs sits right on I-70 / US-40.
_IDAHO_SPRINGS = (-105.51, 39.74)


def test_nearest_road_returns_close_named_road(_roads_ready):
    r = nearest_road(*_IDAHO_SPRINGS)
    assert r is not None
    assert r["meters"] < 1000  # a town on the interstate is near a road
    assert r["name"]  # named
    assert r["category"] in {"road", "trail"}


def test_drivable_only_excludes_trails(_roads_ready):
    drivable = nearest_road(*_IDAHO_SPRINGS, drivable_only=True)
    assert drivable is not None
    assert drivable["category"] == "road"


def test_accessibility_rates_town_as_accessible(_roads_ready):
    a = accessibility(*_IDAHO_SPRINGS)
    assert a["rating"] in {"roadside", "easy", "moderate"}
    assert a["nearest_drivable_road_m"] is not None
