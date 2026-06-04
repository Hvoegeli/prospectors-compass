"""Generic proximity / containment helpers (buffer + intersection).

`features_within` answers "what <layer> features are within R meters of here?"
(a metric buffer query); `point_in` answers "which <layer> polygon(s) contain
this point?" (e.g. which geologic unit / ownership parcel / district / forest).

Layer names are whitelisted → the table name in the SQL is never user input
(same guard as the /layers API).
"""

from __future__ import annotations

from prospector.spatial._db import PT, query_all

#: Friendly layer name → PostGIS table. Whitelist (guards the SQL table name).
_TABLES: dict[str, str] = {
    "counties": "counties",
    "mrds": "mrds_sites",
    "usmin": "usmin_features",
    "geology": "geologic_units",
    "ownership": "land_ownership",
    "roads": "roads",
    "districts": "mining_districts",
    "potential": "mineral_potential",
    "aml": "aml_hazards",
    "forests": "admin_forests",
    "watersheds": "watersheds",
}


def _table(layer: str) -> str:
    table = _TABLES.get(layer)
    if table is None:
        raise ValueError(f"unknown layer '{layer}' (expected one of {sorted(_TABLES)})")
    return table


def features_within(
    layer: str, lon: float, lat: float, radius_m: float, *, limit: int = 50
) -> list[dict]:
    """Features of ``layer`` within ``radius_m`` meters of the point.

    Returns a list of property dicts (the row minus its geometry) each with an
    added ``meters`` distance, nearest first. ``limit`` caps the result count.
    """
    table = _table(layer)
    sql = f"""
        SELECT to_jsonb(t) - 'geom' AS props,
               ST_Distance(geography(t.geom), geography({PT})) AS meters
        FROM {table} t
        WHERE ST_DWithin(geography(t.geom), geography({PT}), :radius)
        ORDER BY meters
        LIMIT :limit
    """  # noqa: S608 — table from whitelist, not user input
    params = {"lon": lon, "lat": lat, "radius": radius_m, "limit": limit}
    rows = query_all(sql, params)
    return [{**r["props"], "meters": round(r["meters"], 1)} for r in rows]


def point_in(layer: str, lon: float, lat: float) -> list[dict]:
    """Polygon feature(s) of ``layer`` that contain the point.

    Returns a list of property dicts (geometry stripped). Empty if the point
    falls in no polygon, or for non-polygon layers (a point rarely sits exactly
    on a line/point geometry).
    """
    table = _table(layer)
    sql = f"""
        SELECT to_jsonb(t) - 'geom' AS props
        FROM {table} t
        WHERE ST_Contains(t.geom, {PT})
    """  # noqa: S608 — table from whitelist, not user input
    rows = query_all(sql, {"lon": lon, "lat": lat})
    return [r["props"] for r in rows]
