"""Integration check on ingested geologic unit polygons.

Skips cleanly when Postgres is unreachable or geology hasn't been ingested yet
(run `uv run python -m prospector.ingest geology` first).
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
def has_geology(db_conn: psycopg.Connection) -> bool:
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
            "WHERE table_name = 'geologic_units')"
        )
        if not cur.fetchone()[0]:
            pytest.skip("geologic_units table not created yet — run the ingest CLI")
        cur.execute("SELECT count(*) FROM geologic_units")
        if cur.fetchone()[0] == 0:
            pytest.skip("geologic_units table empty — run the ingest CLI")
    return True


def test_geometries_are_valid_wgs84_multipolygons(db_conn, has_geology):
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM geologic_units WHERE ST_SRID(geom) <> 4326 "
            "OR GeometryType(geom) <> 'MULTIPOLYGON' OR NOT ST_IsValid(geom)"
        )
        assert cur.fetchone()[0] == 0


def test_units_were_enriched_from_lookup(db_conn, has_geology):
    # The merge with the unit lookup should populate unit_name for most polygons.
    with db_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM geologic_units WHERE unit_name IS NOT NULL")
        assert cur.fetchone()[0] > 0


def test_clipped_to_focus_area(db_conn, has_geology):
    # Cross-engine FP noise means a few polygon edges poke out by nanometers, so
    # we assert the AREA outside the focus area is negligible, not exact coverage.
    with db_conn.cursor() as cur:
        cur.execute(
            "WITH fa AS (SELECT ST_Union(geom) AS g FROM counties) "
            "SELECT COALESCE(sum(ST_Area(ST_Difference(gu.geom, fa.g)::geography)), 0) "
            "FROM geologic_units gu, fa"
        )
        overhang_sq_m = float(cur.fetchone()[0])
    assert overhang_sq_m < 1000.0, f"geology extends {overhang_sq_m:.1f} m² beyond focus area"
