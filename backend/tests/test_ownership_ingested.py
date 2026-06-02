"""Integration check on ingested PAD-US land-ownership polygons.

Skips cleanly when Postgres is unreachable or ownership hasn't been ingested
yet (run `uv run python -m prospector.ingest ownership` first).
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
def has_ownership(db_conn: psycopg.Connection) -> bool:
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
            "WHERE table_name = 'land_ownership')"
        )
        if not cur.fetchone()[0]:
            pytest.skip("land_ownership table not created yet — run the ingest CLI")
        cur.execute("SELECT count(*) FROM land_ownership")
        if cur.fetchone()[0] == 0:
            pytest.skip("land_ownership table empty — run the ingest CLI")
    return True


def test_geometries_are_valid_wgs84_multipolygons(db_conn, has_ownership):
    # PAD-US ships invalid (nested-shell) polygons; ingestion must repair them.
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM land_ownership WHERE ST_SRID(geom) <> 4326 "
            "OR GeometryType(geom) <> 'MULTIPOLYGON' OR NOT ST_IsValid(geom)"
        )
        assert cur.fetchone()[0] == 0


def test_every_record_has_as_of_date(db_conn, has_ownership):
    # Land-status records must carry an "as-of" date stamp (PRD §9.4).
    with db_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM land_ownership WHERE as_of_date IS NULL")
        assert cur.fetchone()[0] == 0


def test_federal_lands_present(db_conn, has_ownership):
    # The whole point of this layer: BLM / Forest Service land must show up.
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM land_ownership WHERE manager_name IN "
            "('Bureau of Land Management', 'Forest Service')"
        )
        assert cur.fetchone()[0] > 0


def test_clipped_to_focus_area(db_conn, has_ownership):
    with db_conn.cursor() as cur:
        cur.execute(
            "WITH fa AS (SELECT ST_Union(geom) AS g FROM counties) "
            "SELECT COALESCE(sum(ST_Area(ST_Difference(o.geom, fa.g)::geography)), 0) "
            "FROM land_ownership o, fa"
        )
        overhang_sq_m = float(cur.fetchone()[0])
    assert overhang_sq_m < 1000.0, f"ownership extends {overhang_sq_m:.1f} m² beyond focus area"
