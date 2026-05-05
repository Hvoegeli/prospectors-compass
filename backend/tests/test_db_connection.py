"""Sanity check that the backend can reach the running Postgres container
and that PostGIS + pgvector are loaded. Requires `docker compose up -d`."""

import psycopg
import pytest

from prospector.config import settings


@pytest.fixture(scope="module")
def db_conn() -> psycopg.Connection:
    try:
        conn = psycopg.connect(settings.database_url, connect_timeout=2)
    except psycopg.OperationalError as exc:
        pytest.skip(f"Postgres not reachable at {settings.database_url}: {exc}")
    yield conn
    conn.close()


def test_database_reachable(db_conn: psycopg.Connection) -> None:
    with db_conn.cursor() as cur:
        cur.execute("SELECT 1")
        assert cur.fetchone() == (1,)


def test_postgis_and_vector_extensions_present(db_conn: psycopg.Connection) -> None:
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT extname FROM pg_extension WHERE extname IN ('postgis', 'vector')"
        )
        extensions = {row[0] for row in cur.fetchall()}
    assert "postgis" in extensions, "postgis extension not loaded"
    assert "vector" in extensions, "pgvector extension not loaded"
