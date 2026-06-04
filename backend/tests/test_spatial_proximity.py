"""Tests for the proximity helpers (features_within / point_in).

Skips when Postgres is unreachable or the relevant layers aren't ingested.
"""

import psycopg
import pytest

from prospector.config import settings
from prospector.spatial.proximity import features_within, point_in


@pytest.fixture(scope="module")
def _db():
    try:
        conn = psycopg.connect(settings.database_url, connect_timeout=2)
    except psycopg.OperationalError as exc:
        pytest.skip(f"Postgres not reachable: {exc}")
    yield conn
    conn.close()


def _has_rows(conn, table: str) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name=%s)",
            (table,),
        )
        if not cur.fetchone()[0]:
            return False
        cur.execute(f"SELECT count(*) FROM {table}")  # noqa: S608 — fixed test table names
        return cur.fetchone()[0] > 0


_IDAHO_SPRINGS = (-105.51, 39.74)


def test_point_in_geology_returns_a_unit(_db):
    if not _has_rows(_db, "geologic_units"):
        pytest.skip("geologic_units not ingested")
    units = point_in("geology", *_IDAHO_SPRINGS)
    assert len(units) >= 1
    assert units[0].get("generalized_lith") or units[0].get("unit_name")


def test_features_within_finds_nearby_mines(_db):
    if not _has_rows(_db, "mrds_sites"):
        pytest.skip("mrds_sites not ingested")
    mines = features_within("mrds", *_IDAHO_SPRINGS, 2000, limit=10)
    assert mines  # the Idaho Springs gold district has mines within 2 km
    assert all(m["meters"] <= 2000 for m in mines)
    # sorted nearest-first
    assert mines == sorted(mines, key=lambda m: m["meters"])


def test_unknown_layer_raises():
    with pytest.raises(ValueError, match="unknown layer"):
        point_in("not_a_layer", 0, 0)
