"""Integration check on ingested roads + trails.

Skips when Postgres is unreachable or roads haven't been ingested
(run `uv run python -m prospector.ingest roads`).
"""

import psycopg
import pytest

from prospector.config import settings


@pytest.fixture(scope="module")
def db_conn() -> psycopg.Connection:
    try:
        conn = psycopg.connect(settings.database_url, connect_timeout=2)
    except psycopg.OperationalError as exc:
        pytest.skip(f"Postgres not reachable: {exc}")
    yield conn
    conn.close()


@pytest.fixture(scope="module")
def has_roads(db_conn: psycopg.Connection) -> bool:
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'roads')"
        )
        if not cur.fetchone()[0]:
            pytest.skip("roads table not created yet — run the ingest CLI")
        cur.execute("SELECT count(*) FROM roads")
        if cur.fetchone()[0] == 0:
            pytest.skip("roads table empty — run the ingest CLI")
    return True


def test_has_both_roads_and_trails(db_conn, has_roads):
    with db_conn.cursor() as cur:
        cur.execute("SELECT DISTINCT category FROM roads")
        cats = {r[0] for r in cur.fetchall()}
    assert {"road", "trail"} <= cats


def test_geometries_valid_wgs84_multilinestrings(db_conn, has_roads):
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM roads WHERE ST_SRID(geom) <> 4326 "
            "OR GeometryType(geom) <> 'MULTILINESTRING' OR NOT ST_IsValid(geom)"
        )
        assert cur.fetchone()[0] == 0
