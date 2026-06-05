"""Ingest CGS mapped fault lines, clipped to the focus area.

Statewide fault compilation (~1:500k, from the Tweto state structural map) via the
CGS ArcGIS Fault_Server (layer 15 = `colorado_500k_shp`), bbox-queried + clipped to
the dissolved county union. Faults/fractures are the dominant structural control on
LODE mineralization — ore clusters along them — so this feeds the recommendation
engine's lode "proximity to structure" factor. Geometry-only (the source's
attributes are cryptic ARC/INFO coding fields with no usable fault name/type).

Source: Colorado Geological Survey. License: CGS state-gov data (see DATA_SOURCES).
"""

from __future__ import annotations

import logging

import geopandas as gpd
from geoalchemy2.shape import from_shape
from sqlalchemy import delete

from prospector.db.base import Base, SessionLocal, engine
from prospector.db.models import Fault
from prospector.ingest.arcgis import fetch_features
from prospector.ingest.census import load_region_counties
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.util import to_multilinestring

log = logging.getLogger(__name__)

WGS84 = 4326
#: CGS Fault_Server, layer 15 = "colorado_500k_shp" (statewide bedrock faults).
FAULTS_QUERY = (
    "https://cgsarcimage.mines.edu/arcgis/rest/services/cgs_services/Fault_Server/MapServer/15/query"
)


def load_region_faults(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Load fault polylines clipped to ``region``'s counties (WGS84). Geometry only."""
    counties = load_region_counties(region)
    bbox = tuple(counties.total_bounds)
    mask = counties.geometry.union_all()

    # TWETO_ID is just to satisfy outFields; we keep only the geometry. OBJECTID is
    # a stable unique sort key for offset paging (the layer caps at 1000/page).
    features = fetch_features(
        FAULTS_QUERY, bbox, out_fields="TWETO_ID", order_by="OBJECTID", page=1000
    )
    if not features:
        return gpd.GeoDataFrame(columns=["geometry"], crs=WGS84)

    gdf = gpd.GeoDataFrame.from_features(features, crs=WGS84)
    clipped = gpd.clip(gdf, mask, keep_geom_type=True)
    clipped = clipped[clipped.geometry.notna() & ~clipped.geometry.is_empty].copy()
    clipped["geometry"] = clipped.geometry.apply(to_multilinestring)
    return clipped[clipped.geometry.notna()].copy()


def ingest_faults(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download (REST) + clip + store CGS fault lines. Idempotent.

    Re-ingest is scoped by ``state_fips``. Returns the number of rows written.
    """
    Base.metadata.create_all(engine)
    gdf = load_region_faults(region)

    with SessionLocal() as session:
        session.execute(delete(Fault).where(Fault.state_fips == region.state_fips))
        for row in gdf.itertuples(index=False):
            session.add(Fault(state_fips=region.state_fips, geom=from_shape(row.geometry, srid=WGS84)))
        session.commit()
        count = len(gdf)

    log.info("Ingested %d fault segments for region '%s'", count, region.name)
    return count
