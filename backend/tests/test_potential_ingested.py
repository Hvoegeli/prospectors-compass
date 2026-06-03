"""Integration check on ingested CGS mineral-resource potential.

Skips when Postgres is unreachable or potential hasn't been ingested
(run `uv run python -m prospector.ingest potential`).
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
def has_potential(db_conn: psycopg.Connection) -> bool:
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
            "WHERE table_name = 'mineral_potential')"
        )
        if not cur.fetchone()[0]:
            pytest.skip("mineral_potential table not created yet — run the ingest CLI")
        cur.execute("SELECT count(*) FROM mineral_potential")
        if cur.fetchone()[0] == 0:
            pytest.skip("mineral_potential table empty — run the ingest CLI")
    return True


def test_every_row_rates_some_prospecting_target(db_conn, has_potential):
    """We only keep polygons where a prospecting target rates > 0 — no all-null rows."""
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM mineral_potential WHERE "
            "COALESCE(au_placer,0)=0 AND COALESCE(pegmatite,0)=0 AND COALESCE(corundum,0)=0 "
            "AND COALESCE(rare_earth,0)=0 AND COALESCE(fluorite,0)=0"
        )
        assert cur.fetchone()[0] == 0


def test_ratings_within_known_scale(db_conn, has_potential):
    """CGS favorability ratings are 1 (low), 2 (moderate), 3 (high)."""
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM mineral_potential WHERE au_placer IS NOT NULL "
            "AND au_placer NOT BETWEEN 1 AND 3"
        )
        assert cur.fetchone()[0] == 0


def test_geometries_valid_wgs84_multipolygons(db_conn, has_potential):
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM mineral_potential WHERE ST_SRID(geom) <> 4326 "
            "OR GeometryType(geom) <> 'MULTIPOLYGON' OR NOT ST_IsValid(geom)"
        )
        assert cur.fetchone()[0] == 0
