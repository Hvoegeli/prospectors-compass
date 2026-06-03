"""Integration check on ingested CGS historic metal-mining districts.

Skips when Postgres is unreachable or districts haven't been ingested
(run `uv run python -m prospector.ingest districts`).
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
def has_districts(db_conn: psycopg.Connection) -> bool:
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
            "WHERE table_name = 'mining_districts')"
        )
        if not cur.fetchone()[0]:
            pytest.skip("mining_districts table not created yet — run the ingest CLI")
        cur.execute("SELECT count(*) FROM mining_districts")
        if cur.fetchone()[0] == 0:
            pytest.skip("mining_districts table empty — run the ingest CLI")
    return True


def test_includes_leadville(db_conn, has_districts):
    """Leadville is a flagship I-70-corridor district — sanity that the clip kept it."""
    with db_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM mining_districts WHERE district ILIKE '%Leadville%'")
        assert cur.fetchone()[0] >= 1


def test_districts_link_to_cgs_reports(db_conn, has_districts):
    """Each district should carry its CGS county-report URL (provenance)."""
    with db_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM mining_districts WHERE web_page LIKE 'http%'")
        assert cur.fetchone()[0] >= 1


def test_geometries_valid_wgs84_multipolygons(db_conn, has_districts):
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM mining_districts WHERE ST_SRID(geom) <> 4326 "
            "OR GeometryType(geom) <> 'MULTIPOLYGON' OR NOT ST_IsValid(geom)"
        )
        assert cur.fetchone()[0] == 0
