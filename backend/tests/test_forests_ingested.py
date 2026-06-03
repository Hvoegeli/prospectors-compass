"""Integration check on ingested USFS Administrative Forest boundaries.

Skips when Postgres is unreachable or forests haven't been ingested
(run `uv run python -m prospector.ingest forests`).
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
def has_forests(db_conn: psycopg.Connection) -> bool:
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
            "WHERE table_name = 'admin_forests')"
        )
        if not cur.fetchone()[0]:
            pytest.skip("admin_forests table not created yet — run the ingest CLI")
        cur.execute("SELECT count(*) FROM admin_forests")
        if cur.fetchone()[0] == 0:
            pytest.skip("admin_forests table empty — run the ingest CLI")
    return True


def test_includes_white_river(db_conn, has_forests):
    """White River NF dominates the I-70 high country — it must be present."""
    with db_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM admin_forests WHERE forest_name ILIKE '%White River%'")
        assert cur.fetchone()[0] >= 1


def test_geometries_valid_wgs84_multipolygons(db_conn, has_forests):
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM admin_forests WHERE ST_SRID(geom) <> 4326 "
            "OR GeometryType(geom) <> 'MULTIPOLYGON' OR NOT ST_IsValid(geom)"
        )
        assert cur.fetchone()[0] == 0
