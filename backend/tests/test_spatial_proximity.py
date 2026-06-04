"""Tests for the proximity helpers (features_within / point_in).

Skips when Postgres is unreachable or the relevant layers aren't ingested.
"""

import pytest

from prospector.spatial.proximity import features_within, point_in

_IDAHO_SPRINGS = (-105.51, 39.74)


def test_point_in_geology_returns_a_unit(require_table):
    require_table("geologic_units")
    units = point_in("geology", *_IDAHO_SPRINGS)
    assert len(units) >= 1
    assert units[0].get("generalized_lith") or units[0].get("unit_name")


def test_features_within_finds_nearby_mines(require_table):
    require_table("mrds_sites")
    mines = features_within("mrds", *_IDAHO_SPRINGS, 2000, limit=10)
    assert mines  # the Idaho Springs gold district has mines within 2 km
    assert all(m["meters"] <= 2000 for m in mines)
    # sorted nearest-first
    assert mines == sorted(mines, key=lambda m: m["meters"])


def test_unknown_layer_raises():
    with pytest.raises(ValueError, match="unknown layer"):
        point_in("not_a_layer", 0, 0)
