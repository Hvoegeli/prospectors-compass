"""Shared test fixtures: a live Postgres connection and a table-availability gate.

The spatial tools query ingested PostGIS layers, so their tests need a reachable
database with the relevant table populated. These fixtures *skip* (rather than
fail) when Postgres is down or a layer hasn't been ingested, so the suite stays
green in environments without the full data pipeline.
"""

import psycopg
import pytest

from prospector.config import settings


@pytest.fixture(scope="session")
def db_conn():
    """A live Postgres connection, or skip the test when one can't be opened."""
    try:
        conn = psycopg.connect(settings.database_url, connect_timeout=2)
    except psycopg.OperationalError as exc:
        pytest.skip(f"Postgres not reachable: {exc}")
    yield conn
    conn.close()


@pytest.fixture(scope="session")
def require_table(db_conn):
    """Return a gate: ``require_table('roads')`` skips unless the table has rows."""

    def _require(table: str) -> None:
        with db_conn.cursor() as cur:
            cur.execute(
                "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name=%s)",
                (table,),
            )
            if not cur.fetchone()[0]:
                pytest.skip(f"{table} table not created — run the ingest CLI")
            cur.execute(f"SELECT count(*) FROM {table}")  # noqa: S608 — fixed test table names
            if cur.fetchone()[0] == 0:
                pytest.skip(f"{table} table empty — run the ingest CLI")

    return _require
