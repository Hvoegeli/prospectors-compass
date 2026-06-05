"""Small shared helpers for ingestion."""

from __future__ import annotations

import pandas as pd
from shapely.geometry import MultiLineString, MultiPolygon


def na_to_none(value: object) -> str | None:
    """Pandas NaN / None -> None; everything else -> str (DB stores text or NULL)."""
    return None if value is None or pd.isna(value) else str(value)


def na_to_float(value: object) -> float | None:
    """Pandas NaN / None -> None; everything else -> float (for numeric columns).

    Use instead of ``na_to_none`` on float/numeric columns: ``na_to_none`` would
    stringify the value, and a bare pass-through would let pandas NaN land in the
    column as IEEE NaN instead of SQL NULL.
    """
    return None if value is None or pd.isna(value) else float(value)


def to_multipolygon(geom: object) -> MultiPolygon | None:
    """Coerce a Polygon/MultiPolygon to MultiPolygon; drop empties and other types.

    Used after ``gpd.clip(..., keep_geom_type=True)``, which already restricts the
    output to polygonal geometries. (``padus.py`` keeps its own richer variant that
    also unpacks the ``GeometryCollection``s its ``make_valid`` repair can produce.)
    """
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type == "MultiPolygon":
        return geom
    if geom.geom_type == "Polygon":
        return MultiPolygon([geom])
    return None


def to_multilinestring(geom: object) -> MultiLineString | None:
    """Coerce a LineString/MultiLineString to MultiLineString; drop empties/others.

    Used after ``gpd.clip(..., keep_geom_type=True)`` on line layers (roads, NHD
    stream flowlines), so the column is uniformly MultiLineString for PostGIS.
    """
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type == "MultiLineString":
        return geom
    if geom.geom_type == "LineString":
        return MultiLineString([geom])
    return None
