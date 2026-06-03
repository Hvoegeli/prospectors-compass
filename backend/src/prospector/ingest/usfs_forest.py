"""Ingest USFS Administrative Forest boundaries, clipped to the focus area.

The *proclaimed* national-forest envelopes (e.g. "White River National Forest").
This is broader than the FS-managed parcels already in `land_ownership` (PAD-US):
it answers "which named forest am I in?", which matters because prospecting and
recreational-mining rules differ per forest. We clip the national shapefile to
the dissolved union of the region's counties.

Source: USFS EDW, Administrative Forest Boundaries (national shapefile).
License: public domain (US Government work, 17 U.S.C. §105).
"""

from __future__ import annotations

import logging

import geopandas as gpd
from geoalchemy2.shape import from_shape
from shapely.geometry import MultiPolygon
from sqlalchemy import delete

from prospector.db.base import Base, SessionLocal, engine
from prospector.db.models import AdminForest
from prospector.ingest.census import load_region_counties
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.storage import RAW_DIR, download_file
from prospector.ingest.util import na_to_none

log = logging.getLogger(__name__)

ADMIN_FOREST_URL = (
    "https://data.fs.usda.gov/geodata/edw/edw_resources/shp/S_USA.AdministrativeForest.zip"
)
_ZIP_PATH = RAW_DIR / "usfs" / "AdministrativeForest.zip"
_LAYER = "S_USA.AdministrativeForest"
WGS84 = 4326


def _to_multipolygon(geom: object) -> MultiPolygon | None:
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type == "MultiPolygon":
        return geom
    if geom.geom_type == "Polygon":
        return MultiPolygon([geom])
    return None


def load_region_forests(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Load Administrative Forest polygons clipped to ``region``'s counties (WGS84)."""
    zip_path = download_file(ADMIN_FOREST_URL, _ZIP_PATH)
    counties = load_region_counties(region)
    bbox = counties.total_bounds
    mask = counties.geometry.union_all()

    # bbox-read keeps the whole nation out of memory; then clip to the county union.
    gdf = gpd.read_file(f"zip://{zip_path}!{_LAYER}.shp", bbox=tuple(bbox))
    gdf = gdf.to_crs(epsg=WGS84)
    clipped = gpd.clip(gdf, mask, keep_geom_type=True)
    clipped = clipped[clipped.geometry.notna() & ~clipped.geometry.is_empty].copy()
    clipped["geometry"] = clipped.geometry.apply(_to_multipolygon)
    return clipped[clipped.geometry.notna()].copy()


def ingest_forests(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download + clip + store Administrative Forest boundaries. Idempotent.

    Re-ingest is scoped by ``state_fips``. Returns the number of rows written.
    """
    Base.metadata.create_all(engine)
    gdf = load_region_forests(region)

    with SessionLocal() as session:
        session.execute(delete(AdminForest).where(AdminForest.state_fips == region.state_fips))
        for row in gdf.itertuples(index=False):
            session.add(
                AdminForest(
                    state_fips=region.state_fips,
                    forest_name=na_to_none(row.FORESTNAME),
                    region=na_to_none(row.REGION),
                    forest_code=na_to_none(row.FORESTORGC),
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(gdf)

    log.info("Ingested %d Administrative Forest boundaries for region '%s'", count, region.name)
    return count
