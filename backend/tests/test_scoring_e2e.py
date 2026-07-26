"""End-to-end scoring fixtures over the live PostGIS layers.

Unlike ``test_scoring_radiometric.py`` (pure-unit: weights + membership ramps),
this exercises the WHOLE ``score_area`` path against real Colorado geography:
the grid SQL, every layer join, the factor rationale, the legality gates, and
the min-score filter.

To stay robust (not tied to a guessed lat/lon that a data refresh could move),
the test is DATA-DRIVEN: it asks the database for genuinely favorable ground —
the largest polygon the CGS rates highest for the target — then scores a small
bbox around it and asserts the engine surfaces it as favorable, with the right
factor leading. If a weighting regression scrambled the profile (e.g. mine/fault
proximity started dominating gem scoring), these would fail.

Skips cleanly when Postgres is down or the scoring layers haven't been ingested,
so the suite stays green without the full data pipeline.
"""

import psycopg
import pytest

from prospector.config import settings
from prospector.engine.scoring import score_area

# Real tables the scoring SQL joins (source_basins is a CTE, not a table).
_SCORING_TABLES = (
    "mrds_sites", "streams", "faults", "mining_districts", "geologic_units",
    "mineral_potential", "radiometric", "mining_claims", "land_ownership",
    "watersheds", "counties",
)

# The rationale keys every factor must carry (the §5 verification contract).
_FACTOR_KEYS = {"name", "label", "raw", "membership", "weight", "contribution"}


@pytest.fixture(scope="module")
def db_conn() -> psycopg.Connection:
    try:
        conn = psycopg.connect(settings.database_url, connect_timeout=2)
    except psycopg.OperationalError as exc:
        pytest.skip(f"Postgres not reachable: {exc}")
    yield conn
    conn.close()


@pytest.fixture(scope="module")
def scoring_data_ready(db_conn: psycopg.Connection) -> bool:
    """Skip unless every scoring table exists and mineral_potential is populated.

    Intentionally-empty optional layers are fine (they LEFT JOIN to nothing); only
    a *missing* table would raise, and the potential layer is the scoring driver.
    """
    with db_conn.cursor() as cur:
        for table in _SCORING_TABLES:
            cur.execute("SELECT to_regclass(%s)", (f"public.{table}",))
            if cur.fetchone()[0] is None:
                pytest.skip(f"{table} not created — run the ingest CLI")
        cur.execute("SELECT count(*) FROM mineral_potential")
        if cur.fetchone()[0] == 0:
            pytest.skip("mineral_potential empty — run `python -m prospector.ingest potential`")
    return True


def _favorable_bbox(
    db_conn: psycopg.Connection, potential_col: str, pad_deg: float = 0.03
) -> tuple[float, float, float, float]:
    """A small bbox around the largest polygon the CGS rates highest for this target.

    ``pad_deg`` (~3 km each side) is wide enough to span mixed land ownership, so the
    result isn't emptied by the legality gates if the top-rated polygon happens to sit
    on private ground — while staying small enough to score fast (well under max_cells).
    """
    with db_conn.cursor() as cur:
        # potential_col is a fixed literal chosen by this test, never user input.
        cur.execute(
            f"""
            SELECT ST_X(ST_Centroid(geom)), ST_Y(ST_Centroid(geom))
            FROM mineral_potential
            WHERE {potential_col} = (SELECT max({potential_col}) FROM mineral_potential)
            ORDER BY ST_Area(geom) DESC
            LIMIT 1
            """  # noqa: S608 — potential_col is a hardcoded allowlisted column name
        )
        row = cur.fetchone()
    if row is None or row[0] is None:
        pytest.skip(f"no rated polygon for {potential_col}")
    lon, lat = row
    return (lon - pad_deg, lat - pad_deg, lon + pad_deg, lat + pad_deg)


def _assert_scoring_contract(result: dict, target: str, profile: str) -> list[dict]:
    """Universal invariants every score_area result must satisfy; returns the cells."""
    assert result["target"] == target
    assert result["profile"] == profile
    cells = result["cells"]
    assert result["count"] == len(cells)
    assert cells, "favorable ground should surface at least one candidate cell"

    # Sorted best-first (the API/UI rely on this ordering).
    scores = [c["score"] for c in cells]
    assert scores == sorted(scores, reverse=True)

    for c in cells:
        assert 15.0 <= c["score"] <= 100.0  # min_score (0.15) honored; 0-100 scale
        assert c["band"] in {"high", "moderate", "low"}
        assert c["factors"], "every recommendation must carry its factor rationale (§5)"
        for f in c["factors"]:
            assert _FACTOR_KEYS <= set(f), f"factor missing keys: {f}"
        # Factors sorted by contribution (the rationale reads high→low).
        contribs = [f["contribution"] for f in c["factors"]]
        assert contribs == sorted(contribs, reverse=True)
        # The land-status + claims gates are always present (never a silent go/no-go).
        gate_names = {g["name"] for g in c["gates"]}
        assert {"land_ownership", "active_claims"} <= gate_names
        for g in c["gates"]:
            assert 0.0 <= g["gate"] <= 1.0
    return cells


def test_scores_favorable_pegmatite_ground(db_conn, scoring_data_ready):
    """Gem profile over the best-rated pegmatite ground: candidates surface, the
    CGS potential we deliberately scored is credited, and rock-favorability leads
    (not generic mine/fault/district proximity)."""
    bbox = _favorable_bbox(db_conn, "pegmatite")
    cells = _assert_scoring_contract(score_area("pegmatite", bbox), "pegmatite", "gem")

    # Regression guard #1: the engine credits the max CGS rating (3 → membership 1.0)
    # somewhere in this deliberately-favorable bbox.
    max_cgs = max(
        (f["membership"] for c in cells for f in c["factors"] if f["name"] == "cgs_potential"),
        default=0.0,
    )
    assert max_cgs >= 0.9, f"expected high CGS pegmatite membership, got {max_cgs}"

    # Regression guard #2: gem scoring LEADS with rock-favorability in its top cell.
    top_factor = cells[0]["factors"][0]["name"]
    assert top_factor in {"granite_fertility", "cgs_potential", "host_lith"}, top_factor


def test_scores_favorable_placer_ground(db_conn, scoring_data_ready):
    """Placer profile over the best-rated placer ground. Exercises the placer-only
    slope-sampling path (valley_grade) end-to-end and the full rationale contract."""
    bbox = _favorable_bbox(db_conn, "au_placer")
    cells = _assert_scoring_contract(score_area("au_placer", bbox), "au_placer", "placer")

    # The placer profile folds CGS rating into the ``known_mineralization`` factor
    # (fuzzy-OR of placer-mine proximity, district proximity, and CGS rating). Over
    # the max-rated polygon the CGS term is 1.0, so this factor must read near-full.
    max_known = max(
        (f["membership"] for c in cells for f in c["factors"] if f["name"] == "known_mineralization"),
        default=0.0,
    )
    assert max_known >= 0.9, f"expected high known-mineralization membership, got {max_known}"


def test_unknown_target_rejected():
    """A bad target name is a clear error, not a silent empty result."""
    with pytest.raises(ValueError, match="unknown target"):
        score_area("unobtainium", (-105.5, 39.0, -105.4, 39.1))
