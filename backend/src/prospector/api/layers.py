"""Serve ingested PostGIS layers as GeoJSON for the desktop map.

One generic endpoint builds a GeoJSON FeatureCollection straight in Postgres
(`ST_AsGeoJSON` + `to_jsonb`), so adding a layer is just a whitelist entry.
Layer names are whitelisted → the table name in the SQL is never user input.
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
}


@router.get("")
def list_layers() -> dict[str, list[str]]:
    """Available layer names for the map."""
    return {"layers": list(LAYERS)}


@router.get("/{name}")
def get_layer(
    name: str,
    bbox: str | None = Query(None, description="minLon,minLat,maxLon,maxLat (WGS84)"),
    limit: int = Query(50_000, ge=1, le=200_000),
) -> dict:
    """Return a layer as a GeoJSON FeatureCollection (optionally bbox-filtered)."""
    table = LAYERS.get(name)
    if table is None:
        raise HTTPException(status_code=404, detail=f"unknown layer '{name}'")

    params: dict[str, object] = {"lim": limit}
    where = ""
    if bbox:
        try:
            minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="bbox must be 'minLon,minLat,maxLon,maxLat'"
            ) from exc
        where = "WHERE t.geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)"
        params |= {"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy}

    # table/where are server-controlled (whitelist + fixed string); values are bound.
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
