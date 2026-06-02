"""Integration check on the ingested county clip mask.

Skips cleanly when Postgres is unreachable or the clip mask hasn't been
ingested yet (run `uv run python -m prospector.ingest counties` first), so the
suite stays green in environments without data.
"""

import psycopg
import pytest

from prospector.config import settings
from prospector.ingest.focus_area import DEFAULT_REGION


@pytest.fixture(scope="module")
def db_conn() -> psycopg.Connection:
    try:
        conn = psycopg.connect(settings.database_url, connect_timeout=2)
    except psycopg.OperationalError as exc:
        pytest.skip(f"Postgres not reachable: {exc}")
    yield conn
    conn.close()


@pytest.fixture(scope="module")
def has_counties(db_conn: psycopg.Connection) -> bool:
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
            "WHERE table_name = 'counties')"
        )
        if not cur.fetchone()[0]:
            pytest.skip("counties table not created yet — run the ingest CLI")
        cur.execute("SELECT count(*) FROM counties")
        if cur.fetchone()[0] == 0:
            pytest.skip("counties table empty — run the ingest CLI")
    return True


def test_all_focus_area_counties_present(db_conn, has_counties):
    with db_conn.cursor() as cur:
        cur.execute("SELECT geoid FROM counties")
        present = {row[0] for row in cur.fetchall()}
    for geoid in DEFAULT_REGION.geoids():
        assert geoid in present, f"missing county {geoid}"


def test_geometries_valid_and_wgs84(db_conn, has_counties):
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM counties "
            "WHERE NOT ST_IsValid(geom) OR ST_SRID(geom) <> 4326"
        )
        assert cur.fetchone()[0] == 0, "found invalid or non-4326 geometries"
