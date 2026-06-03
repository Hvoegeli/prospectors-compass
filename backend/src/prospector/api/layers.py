"""Serve ingested PostGIS layers as GeoJSON for the desktop map.

One generic endpoint builds a GeoJSON FeatureCollection straight in Postgres
(`ST_AsGeoJSON` + `to_jsonb`), so adding a layer is just a whitelist entry.
Layer names are whitelisted → the table name in the SQL is never user input.

The `mrds` layer additionally supports `commodity` and `dep_type` filters (for
the target-material dropdown), plus a `/layers/mrds/facets` endpoint that lists
the available commodities (tokenized from the comma-joined commod1-3 fields) and
deposit types.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text

from prospector.db.base import engine

router = APIRouter(prefix="/layers", tags=["layers"])

#: Friendly layer name -> PostGIS table. Whitelist (guards the table name in SQL).
LAYERS: dict[str, str] = {
    "counties": "counties",
    "mrds": "mrds_sites",
    "usmin": "usmin_features",
    "geology": "geologic_units",
    "ownership": "land_ownership",
    "roads": "roads",
    "trails": "roads",
    "forests": "admin_forests",
    "districts": "mining_districts",
    "potential": "mineral_potential",
    "aml": "aml_hazards",
}

#: Layers backed by a shared table, distinguished by a fixed category filter.
_LAYER_CATEGORY: dict[str, str] = {"roads": "road", "trails": "trail"}

# Tokenize the comma-joined commod1-3 into individual commodities for both the
# facet list and the filter, so "Gold" matches a "Gold, Silver" site.
_COMMOD_TOKENS = "string_to_array(concat_ws(', ', t.commod1, t.commod2, t.commod3), ', ')"


@router.get("")
def list_layers() -> dict[str, list[str]]:
    """Available layer names for the map."""
    return {"layers": list(LAYERS)}


@router.get("/mrds/facets")
def mrds_facets() -> dict[str, list[str]]:
    """Distinct commodities (tokenized) and deposit types for the dropdowns."""
    commod_sql = text(
        "SELECT DISTINCT tok FROM mrds_sites t, "
        "unnest(string_to_array(concat_ws(', ', t.commod1, t.commod2, t.commod3), ', ')) AS tok "
        "WHERE tok <> '' ORDER BY tok"
    )
    dep_sql = text(
        "SELECT DISTINCT dep_type FROM mrds_sites "
        "WHERE dep_type IS NOT NULL AND dep_type <> '' ORDER BY dep_type"
    )
    with engine.connect() as conn:
        commodities = [r[0] for r in conn.execute(commod_sql)]
        deposit_types = [r[0] for r in conn.execute(dep_sql)]
    return {"commodities": commodities, "deposit_types": deposit_types}


@router.get("/{name}")
def get_layer(
    name: str,
    bbox: str | None = Query(None, description="minLon,minLat,maxLon,maxLat (WGS84)"),
    commodity: str | None = Query(None, description="filter mrds to this commodity"),
    dep_type: str | None = Query(None, description="filter mrds to this deposit type"),
    limit: int = Query(50_000, ge=1, le=200_000),
) -> dict:
    """Return a layer as a GeoJSON FeatureCollection (optionally filtered)."""
    table = LAYERS.get(name)
    if table is None:
        raise HTTPException(status_code=404, detail=f"unknown layer '{name}'")

    params: dict[str, object] = {"lim": limit}
    conditions: list[str] = []

    if name in _LAYER_CATEGORY:
        conditions.append("t.category = :category")
        params["category"] = _LAYER_CATEGORY[name]

    if bbox:
        try:
            minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="bbox must be 'minLon,minLat,maxLon,maxLat'"
            ) from exc
        conditions.append("t.geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)")
        params |= {"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy}

    # commodity / dep_type filters only apply to the mrds layer (only it has them).
    if name == "mrds":
        if commodity:
            conditions.append(f":commodity = ANY({_COMMOD_TOKENS})")
            params["commodity"] = commodity
        if dep_type:
            conditions.append("t.dep_type = :dep_type")
            params["dep_type"] = dep_type

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    # table/where are server-controlled (whitelist + fixed strings); values are bound.
    sql = text(
        f"""
        SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(jsonb_agg(feature), '[]'::jsonb)
        )
        FROM (
            SELECT jsonb_build_object(
                'type', 'Feature',
                'geometry', ST_AsGeoJSON(t.geom)::jsonb,
                'properties', to_jsonb(t) - 'geom'
            ) AS feature
            FROM {table} t
            {where}
            LIMIT :lim
        ) sub
        """  # noqa: S608 — table from whitelist, not user input
    )
    with engine.connect() as conn:
        return conn.execute(sql, params).scalar_one()
