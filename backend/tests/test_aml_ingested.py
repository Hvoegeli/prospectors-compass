"""Integration check on ingested CGS abandoned-mine-land hazards.

Skips when Postgres is unreachable or AML hasn't been ingested
(run `uv run python -m prospector.ingest aml`).
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
def has_aml(db_conn: psycopg.Connection) -> bool:
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
            "WHERE table_name = 'aml_hazards')"
        )
        if not cur.fetchone()[0]:
            pytest.skip("aml_hazards table not created yet — run the ingest CLI")
        cur.execute("SELECT count(*) FROM aml_hazards")
        if cur.fetchone()[0] == 0:
            pytest.skip("aml_hazards table empty — run the ingest CLI")
    return True


def test_has_both_openings_and_tailings(db_conn, has_aml):
    with db_conn.cursor() as cur:
        cur.execute("SELECT DISTINCT hazard_kind FROM aml_hazards")
        kinds = {r[0] for r in cur.fetchall()}
    assert {"opening", "tailings"} <= kinds


def test_surfaces_dangerous_hazards(db_conn, has_aml):
    """The point of this layer is safety — high-severity hazards must come through."""
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM aml_hazards "
            "WHERE haz_rating IN ('dangerous', 'extreme danger', 'potential danger')"
        )
        assert cur.fetchone()[0] >= 1


def test_geometries_valid_wgs84_points(db_conn, has_aml):
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM aml_hazards WHERE ST_SRID(geom) <> 4326 "
            "OR GeometryType(geom) <> 'POINT' OR NOT ST_IsValid(geom)"
        )
        assert cur.fetchone()[0] == 0
