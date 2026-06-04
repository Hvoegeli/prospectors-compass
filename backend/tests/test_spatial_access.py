"""Tests for the distance-from-road / accessibility spatial tools.

Skips when Postgres is unreachable or the roads layer isn't ingested.
"""

import psycopg
import pytest

from prospector.config import settings
from prospector.spatial.access import accessibility, nearest_road


@pytest.fixture(scope="module")
def _roads_ready() -> bool:
    try:
        conn = psycopg.connect(settings.database_url, connect_timeout=2)
    except psycopg.OperationalError as exc:
        pytest.skip(f"Postgres not reachable: {exc}")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='roads')"
        )
        if not cur.fetchone()[0]:
            conn.close()
            pytest.skip("roads table not created — run the ingest CLI")
        cur.execute("SELECT count(*) FROM roads")
        empty = cur.fetchone()[0] == 0
    conn.close()
    if empty:
        pytest.skip("roads table empty — run the ingest CLI")
    return True


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
