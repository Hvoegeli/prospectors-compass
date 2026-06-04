"""Shared SQL plumbing for the spatial query tools.

One home for the WGS84 point fragment and the connect/execute/map boilerplate
that every spatial tool would otherwise repeat. Callers build the SQL string
(interpolating ``PT`` and any whitelisted table/where fragments) and hand it
here with the bound ``:lon``/``:lat`` params.
"""

from __future__ import annotations

from sqlalchemy import text

from prospector.db.base import engine

#: WGS84 point from bound ``:lon``/``:lat`` params, reused across spatial queries.
PT = "ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)"


def query_first(sql: str, params: dict) -> dict | None:
    """Run ``sql`` and return the first row as a plain dict, or ``None`` if empty."""
    with engine.connect() as conn:
        row = conn.execute(text(sql), params).mappings().first()
    return dict(row) if row else None


def query_all(sql: str, params: dict) -> list[dict]:
    """Run ``sql`` and return every row as a plain dict."""
    with engine.connect() as conn:
        rows = conn.execute(text(sql), params).mappings().all()
    return [dict(r) for r in rows]
