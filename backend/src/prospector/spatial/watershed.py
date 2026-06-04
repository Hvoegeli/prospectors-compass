"""Which drainage basin a point sits in.

Answers via the ingested HUC12 subwatersheds (USGS WBD). Placer gold concentrates
along drainages, so the containing subwatershed — and where it drains to — is a
useful prospecting context unit.
"""

from __future__ import annotations

from prospector.spatial._db import PT, query_first


def watershed_at(lon: float, lat: float) -> dict | None:
    """The HUC12 subwatershed containing the point.

    Returns ``{huc12, name, downstream_huc, areasqkm}``, or ``None`` if the point
    is outside the ingested watersheds (e.g. outside the focus area).
    """
    sql = f"""
        SELECT huc12, name, downstream_huc, areasqkm
        FROM watersheds
        WHERE ST_Contains(geom, {PT})
        LIMIT 1
    """
    return query_first(sql, {"lon": lon, "lat": lat})
