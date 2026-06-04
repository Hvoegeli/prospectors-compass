"""Ingest USGS WBD HUC12 subwatersheds, clipped to the focus area.

Pulled from the TNM WBD ArcGIS MapServer (12-digit hydrologic units, layer 6),
bbox-queried + paginated, then clipped to the dissolved county union. Gives
"which drainage basin is this point in, and what's downstream" — the useful
prospecting unit, since placer gold follows drainages.

Source: USGS Watershed Boundary Dataset. License: public domain (US Gov work).
"""

from __future__ import annotations

import logging

import geopandas as gpd
from geoalchemy2.shape import from_shape
from sqlalchemy import delete

from prospector.db.base import Base, SessionLocal, engine
from prospector.db.models import Watershed
from prospector.ingest.arcgis import fetch_features
from prospector.ingest.census import load_region_counties
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.util import na_to_float, na_to_none, to_multipolygon

log = logging.getLogger(__name__)

WGS84 = 4326
WBD_HUC12_QUERY = (
    "https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer/6/query"
)
_OUT_FIELDS = "huc12,name,tohuc,areasqkm"


def load_region_watersheds(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Load HUC12 subwatershed polygons clipped to ``region``'s counties (WGS84)."""
    counties = load_region_counties(region)
    bbox = tuple(counties.total_bounds)
    mask = counties.geometry.union_all()

    # Small pages: HUC12 polygons are detailed and the WBD service 504s on big
    # geometry requests.
    features = fetch_features(
        WBD_HUC12_QUERY, bbox, out_fields=_OUT_FIELDS, order_by="objectid", page=200
    )
    if not features:
        return gpd.GeoDataFrame(columns=["huc12", "name", "tohuc", "areasqkm", "geometry"], crs=WGS84)

    gdf = gpd.GeoDataFrame.from_features(features, crs=WGS84)
    clipped = gpd.clip(gdf, mask, keep_geom_type=True)
    clipped = clipped[clipped.geometry.notna() & ~clipped.geometry.is_empty].copy()
    clipped["geometry"] = clipped.geometry.apply(to_multipolygon)
    return clipped[clipped.geometry.notna()].copy()


def ingest_watersheds(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download (REST) + clip + store HUC12 subwatersheds. Idempotent.

    Re-ingest is scoped by ``state_fips``. Returns the number of rows written.
    """
    Base.metadata.create_all(engine)
    gdf = load_region_watersheds(region)

    with SessionLocal() as session:
        session.execute(delete(Watershed).where(Watershed.state_fips == region.state_fips))
        for row in gdf.itertuples(index=False):
            session.add(
                Watershed(
                    state_fips=region.state_fips,
                    huc12=na_to_none(getattr(row, "huc12", None)),
                    name=na_to_none(getattr(row, "name", None)),
                    downstream_huc=na_to_none(getattr(row, "tohuc", None)),
                    areasqkm=na_to_float(getattr(row, "areasqkm", None)),
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(gdf)

    log.info("Ingested %d HUC12 subwatersheds for region '%s'", count, region.name)
    return count
