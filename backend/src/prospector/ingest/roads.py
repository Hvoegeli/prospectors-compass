"""Ingest public roads and trails from Census TIGER/Line, clipped to the focus area.

TIGER publishes roads per county. We keep only the classes useful for reaching a
prospecting site and split them into two categories (the two map toggles):

  road  : S1100 Primary (interstates/US highways), S1200 Secondary (state hwys)
  trail : S1500 Vehicular Trail (4WD)

City streets (S1400) and the rest are dropped as noise. USFS forest roads/trails
are a separate, later ingest (this covers the 'public' kind).

Source: US Census Bureau, 2023 TIGER/Line Roads (per county).
License: public domain (US Government work, 17 U.S.C. §105).
"""

from __future__ import annotations

import logging

import geopandas as gpd
import pandas as pd
from geoalchemy2.shape import from_shape
from sqlalchemy import and_, delete

from prospector.db.base import Base, SessionLocal, engine
from prospector.db.models import RoadSegment
from prospector.ingest.census import load_region_counties
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.storage import RAW_DIR, download_file
from prospector.ingest.util import na_to_none, to_multilinestring

log = logging.getLogger(__name__)

TIGER_ROADS_URL = "https://www2.census.gov/geo/tiger/TIGER2023/ROADS/tl_2023_{geoid}_roads.zip"
WGS84 = 4326
PUBLIC = "public"
FOREST = "forest"

# USFS national files (already downloaded to the local cache; see DATA_SOURCES).
_USFS_ROADS = RAW_DIR / "usfs" / "RoadCore_FS.zip"
_USFS_TRAILS = RAW_DIR / "usfs" / "TrailNFS_Publish.zip"

# MTFCC road class -> (category, human label). Anything not here is dropped.
_MTFCC: dict[str, tuple[str, str]] = {
    "S1100": ("road", "Primary"),
    "S1200": ("road", "Secondary"),
    "S1500": ("trail", "4WD trail"),
}


def load_region_roads(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Load + classify TIGER roads/trails for the region's counties (WGS84)."""
    frames = []
    for geoid in region.geoids():
        url = TIGER_ROADS_URL.format(geoid=geoid)
        dest = RAW_DIR / "roads" / f"tl_2023_{geoid}_roads.zip"
        gdf = gpd.read_file(f"zip://{download_file(url, dest)}")
        gdf = gdf[gdf["MTFCC"].isin(_MTFCC)].copy()
        frames.append(gdf)

    roads = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True)) if frames else gpd.GeoDataFrame()
    roads = roads.set_crs(roads.crs or 4269).to_crs(epsg=WGS84)
    roads["category"] = roads["MTFCC"].map(lambda m: _MTFCC[m][0])
    roads["road_class"] = roads["MTFCC"].map(lambda m: _MTFCC[m][1])
    roads["geometry"] = roads["geometry"].apply(to_multilinestring)
    return roads[roads.geometry.notna()].copy()


def ingest_roads(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download + classify + store public roads/trails for ``region``. Idempotent.

    Re-ingest scoped by (state_fips, kind='public'); forest roads are separate.
    Returns the number of rows written.
    """
    Base.metadata.create_all(engine)
    gdf = load_region_roads(region)

    with SessionLocal() as session:
        session.execute(
            delete(RoadSegment).where(
                and_(RoadSegment.state_fips == region.state_fips, RoadSegment.kind == PUBLIC)
            )
        )
        for row in gdf.itertuples(index=False):
            session.add(
                RoadSegment(
                    state_fips=region.state_fips,
                    category=row.category,
                    kind=PUBLIC,
                    name=na_to_none(row.FULLNAME),
                    road_class=row.road_class,
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(gdf)

    log.info("Ingested %d public road/trail segments for region '%s'", count, region.name)
    return count


def _read_usfs_clipped(zip_path, layer: str, bbox, mask) -> gpd.GeoDataFrame:
    """Read a USFS national line layer within ``bbox``, reproject, clip to ``mask``."""
    gdf = gpd.read_file(f"zip://{zip_path}!{layer}.shp", bbox=tuple(bbox))
    gdf = gdf.to_crs(epsg=WGS84)
    clipped = gpd.clip(gdf, mask, keep_geom_type=True)
    clipped["geometry"] = clipped.geometry.apply(to_multilinestring)
    return clipped[clipped.geometry.notna()].copy()


def ingest_forest(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download (cached) + clip + store USFS forest roads & trails. Idempotent.

    Reads the national USFS files with a focus-area bbox filter (so the whole
    nation never loads), then clips to the county union. Forest roads carry
    their operational maintenance level (drivability) as `road_class`. Trails
    are limited to TERRA (land) routes. Re-ingest scoped by (state_fips, 'forest').
    """
    Base.metadata.create_all(engine)
    counties = load_region_counties(region)
    bbox = counties.total_bounds
    mask = counties.geometry.union_all()

    roads = _read_usfs_clipped(_USFS_ROADS, "S_USA.RoadCore_FS", bbox, mask)
    trails = _read_usfs_clipped(_USFS_TRAILS, "S_USA.TrailNFS_Publish", bbox, mask)
    trails = trails[trails["TRAIL_TYPE"] == "TERRA"]  # land trails only

    with SessionLocal() as session:
        session.execute(
            delete(RoadSegment).where(
                and_(RoadSegment.state_fips == region.state_fips, RoadSegment.kind == FOREST)
            )
        )
        for row in roads.itertuples(index=False):
            session.add(
                RoadSegment(
                    state_fips=region.state_fips,
                    category="road",
                    kind=FOREST,
                    name=na_to_none(row.NAME),
                    road_class=na_to_none(row.OPER_MAINT),
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        for row in trails.itertuples(index=False):
            session.add(
                RoadSegment(
                    state_fips=region.state_fips,
                    category="trail",
                    kind=FOREST,
                    name=na_to_none(row.TRAIL_NAME),
                    road_class="Forest trail",
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(roads) + len(trails)

    log.info("Ingested %d forest road/trail segments for region '%s'", count, region.name)
    return count
