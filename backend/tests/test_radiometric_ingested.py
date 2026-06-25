"""Integration check on the ingested airborne radiometric grid.

Skips when Postgres is unreachable or radiometric hasn't been ingested
(run `uv run python -m prospector.ingest radiometric`).
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
def has_radiometric(db_conn: psycopg.Connection) -> bool:
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
            "WHERE table_name = 'radiometric')"
        )
        if not cur.fetchone()[0]:
            pytest.skip("radiometric table not created yet — run the ingest CLI")
        cur.execute("SELECT count(*) FROM radiometric")
        if cur.fetchone()[0] == 0:
            pytest.skip("radiometric table empty — run the ingest CLI")
    return True


def test_geometries_valid_wgs84_points(db_conn, has_radiometric):
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM radiometric WHERE ST_SRID(geom) <> 4326 "
            "OR GeometryType(geom) <> 'POINT' OR NOT ST_IsValid(geom)"
        )
        assert cur.fetchone()[0] == 0


def test_eth_ppm_present_and_physically_sane(db_conn, has_radiometric):
    """Every row carries an equivalent-thorium value in a sane ppm range (crustal
    thorium is single-to-low-double-digit ppm; >100 would signal a unit/parse bug)."""
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM radiometric WHERE eth_ppm IS NULL "
            "OR eth_ppm <= 0 OR eth_ppm > 100"
        )
        assert cur.fetchone()[0] == 0


def test_known_pegmatite_sites_run_thorium_hot(db_conn, has_radiometric):
    """Regression guard on the feature's premise: known Park County gem/pegmatite
    MRDS sites should sit above the regional median eTh (the fertile-granite signal
    the 'granite fertility' scoring factor relies on). Samples the nearest grid cell
    exactly as the engine's per-cell SQL does."""
    with db_conn.cursor() as cur:
        cur.execute("SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY eth_ppm) FROM radiometric")
        regional_median = cur.fetchone()[0]
        cur.execute(
            """
            WITH sites AS (
              SELECT m.geom FROM mrds_sites m
              WHERE m.county_geoid = '08093' AND (
                m.dep_type ILIKE '%pegmatite%'
                OR m.commod1 ILIKE ANY(ARRAY['%beryl%','%gem%','%mica%','%feldspar%','%tantalum%']))
            ),
            sampled AS (
              SELECT (SELECT r.eth_ppm FROM radiometric r
                      WHERE ST_DWithin(r.geom, s.geom, 0.02)
                      ORDER BY r.geom <-> s.geom LIMIT 1) AS eth
              FROM sites s
            )
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY eth)
            FROM sampled WHERE eth IS NOT NULL
            """
        )
        site_median = cur.fetchone()[0]
    assert site_median is not None, "no known Park gem/pegmatite sites sampled"
    assert site_median > regional_median, (
        f"known-site median eTh {site_median:.2f} not above regional median {regional_median:.2f}"
    )
