"""Structural invariants for download regions.

Counties are OPEN-ENDED: the user decides how many to include (on the desktop or
the phone) — there is no required set and no maximum. These tests only check that
whatever region is configured is structurally valid; they deliberately do NOT
assert a county count or require any particular county to be present.
"""

from prospector.ingest.focus_area import (
    DEFAULT_REGION,
    I70_CORRIDOR,
    County,
    DownloadRegion,
)


def test_default_region_is_i70_corridor():
    assert DEFAULT_REGION is I70_CORRIDOR


def test_geoids_are_valid_and_unique():
    # Holds for ANY number of counties — no count or specific county is asserted.
    geoids = I70_CORRIDOR.geoids()
    state_fips = I70_CORRIDOR.state_fips
    assert all(len(g) == 5 and g.startswith(state_fips) for g in geoids)
    # Duplicate GEOIDs would silently drop a county from the clip mask.
    assert len(set(geoids)) == len(geoids)


def test_county_geoid_property():
    # The 5-digit GEOID is state+county — the mechanism, independent of which
    # counties the user has chosen to include.
    assert County("Denver", "031", "08").geoid == "08031"
    assert County("Chaffee", "015", "08").geoid == "08015"


def test_region_is_reusable_for_other_states():
    # The engine is not hardcoded to Colorado: a region in another state works.
    montana = DownloadRegion(
        name="Montana — test",
        state_fips="30",
        state_abbrev="MT",
        counties=(County("Lewis and Clark", "049", "30"),),
    )
    assert montana.geoids() == ["30049"]
