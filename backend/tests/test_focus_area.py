"""Pin the v1 default region to PRD §7.1 so scope can't drift silently."""

from prospector.ingest.focus_area import DEFAULT_REGION, I70_CORRIDOR

# Verbatim from PRD §7.1 — the canonical 10-county I-70 corridor focus area.
PRD_COUNTY_NAMES = {
    "Denver",
    "Jefferson",
    "Clear Creek",
    "Gilpin",
    "Park",
    "Summit",
    "Lake",
    "Eagle",
    "Garfield",
    "Mesa",
}


def test_default_region_is_i70_corridor():
    assert DEFAULT_REGION is I70_CORRIDOR


def test_exactly_ten_focus_area_counties():
    assert len(I70_CORRIDOR.counties) == 10


def test_county_names_match_prd():
    assert set(I70_CORRIDOR.county_names()) == PRD_COUNTY_NAMES


def test_geoids_are_colorado_five_digit():
    geoids = I70_CORRIDOR.geoids()
    assert len(geoids) == 10
    assert all(g.startswith("08") and len(g) == 5 for g in geoids)
    # GEOIDs must be unique — a duplicate would silently drop a county from clips.
    assert len(set(geoids)) == 10


def test_known_geoids_are_correct():
    by_name = {c.name: c.geoid for c in I70_CORRIDOR.counties}
    assert by_name["Denver"] == "08031"
    assert by_name["Clear Creek"] == "08019"
    assert by_name["Mesa"] == "08077"


def test_region_is_reusable_for_other_states():
    # The engine is not hardcoded to Colorado: a region in another state works.
    from prospector.ingest.focus_area import County, DownloadRegion

    montana = DownloadRegion(
        name="Montana — test",
        state_fips="30",
        state_abbrev="MT",
        counties=(County("Lewis and Clark", "049", "30"),),
    )
    assert montana.geoids() == ["30049"]
