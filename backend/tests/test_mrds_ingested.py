"""Integration check on ingested MRDS mine points.

Skips cleanly when Postgres is unreachable or MRDS hasn't been ingested yet
(run `uv run python -m prospector.ingest mrds` first).
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
def has_mrds(db_conn: psycopg.Connection) -> bool:
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
            "WHERE table_name = 'mrds_sites')"
        )
        if not cur.fetchone()[0]:
            pytest.skip("mrds_sites table not created yet — run the ingest CLI")
        cur.execute("SELECT count(*) FROM mrds_sites")
        if cur.fetchone()[0] == 0:
            pytest.skip("mrds_sites table empty — run the ingest CLI")
    return True


def test_all_sites_tagged_to_focus_area_counties(db_conn, has_mrds):
    with db_conn.cursor() as cur:
        cur.execute("SELECT DISTINCT county_geoid FROM mrds_sites")
        tagged = {row[0] for row in cur.fetchall()}
    assert tagged.issubset(set(DEFAULT_REGION.geoids())), (
        f"sites tagged to counties outside the region: {tagged - set(DEFAULT_REGION.geoids())}"
    )


def test_geometries_are_valid_wgs84_points(db_conn, has_mrds):
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM mrds_sites WHERE ST_SRID(geom) <> 4326 "
            "OR GeometryType(geom) <> 'POINT' OR NOT ST_IsValid(geom)"
        )
        assert cur.fetchone()[0] == 0


def test_every_site_lies_within_its_assigned_county(db_conn, has_mrds):
    # The clip is only correct if each point is actually inside the county it
    # was tagged with — verified by PostGIS independently of the geopandas join.
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM mrds_sites m JOIN counties c "
            "ON c.geoid = m.county_geoid WHERE NOT ST_Within(m.geom, c.geom)"
        )
        assert cur.fetchone()[0] == 0
