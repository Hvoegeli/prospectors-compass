"""Integration check on ingested USMIN mine features.

Skips cleanly when Postgres is unreachable or USMIN hasn't been ingested yet
(run `uv run python -m prospector.ingest usmin` first).
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
def has_usmin(db_conn: psycopg.Connection) -> bool:
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
            "WHERE table_name = 'usmin_features')"
        )
        if not cur.fetchone()[0]:
            pytest.skip("usmin_features table not created yet — run the ingest CLI")
        cur.execute("SELECT count(*) FROM usmin_features")
        if cur.fetchone()[0] == 0:
            pytest.skip("usmin_features table empty — run the ingest CLI")
    return True


def test_all_features_tagged_to_focus_area_counties(db_conn, has_usmin):
    with db_conn.cursor() as cur:
        cur.execute("SELECT DISTINCT county_geoid FROM usmin_features")
        tagged = {row[0] for row in cur.fetchall()}
    assert tagged.issubset(set(DEFAULT_REGION.geoids()))


def test_geometries_are_valid_wgs84_points(db_conn, has_usmin):
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM usmin_features WHERE ST_SRID(geom) <> 4326 "
            "OR GeometryType(geom) <> 'POINT' OR NOT ST_IsValid(geom)"
        )
        assert cur.fetchone()[0] == 0


def test_every_feature_lies_within_its_assigned_county(db_conn, has_usmin):
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM usmin_features u JOIN counties c "
            "ON c.geoid = u.county_geoid WHERE NOT ST_Within(u.geom, c.geom)"
        )
        assert cur.fetchone()[0] == 0
