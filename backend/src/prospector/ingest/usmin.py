"""Ingest USGS USMIN mine/prospect features (point symbols from topo maps).

Per-state point shapefile of mine-related features (adits, shafts, prospects,
etc.) digitized from USGS topographic maps. Same shape as MRDS: build points,
spatially join to the region's county polygons to clip and tag county.

Source: USGS Prospect- and Mine-Related Features (USMIN),
https://mrdata.usgs.gov/usmin/. License: public domain (US Gov work, §105).
"""

from __future__ import annotations

import logging
from pathlib import Path

import geopandas as gpd
import pandas as pd
from geoalchemy2.shape import from_shape
from sqlalchemy import delete

from prospector.db.base import Base, SessionLocal, engine
from prospector.db.models import UsminFeature
from prospector.ingest.census import load_region_counties
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.storage import RAW_DIR, download_file
from prospector.ingest.util import na_to_none

log = logging.getLogger(__name__)

USMIN_URL_TEMPLATE = "https://mrdata.usgs.gov/usmin/state/usmin-{abbrev}.zip"
WGS84 = 4326


def _zip_path(region: DownloadRegion) -> Path:
    return RAW_DIR / "usmin" / f"usmin-{region.state_abbrev}.zip"


def download_usmin(region: DownloadRegion = DEFAULT_REGION, *, force: bool = False) -> Path:
    """Download the per-state USMIN zip to local cache; return its path."""
    url = USMIN_URL_TEMPLATE.format(abbrev=region.state_abbrev)
    return download_file(url, _zip_path(region), force=force)


def load_region_usmin(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Load USMIN point features clipped to ``region``'s counties, tagged with GEOID."""
    zip_path = download_usmin(region)
    points = gpd.read_file(f"zip://{zip_path}!{region.state_abbrev}-point.shp")
    if points.crs is None:
        points = points.set_crs(epsg=WGS84)
    points = points.to_crs(epsg=WGS84)

    mask = load_region_counties(region)[["geoid", "geometry"]]
    # Counties tile without overlap, so a point falls within at most one.
    joined = gpd.sjoin(points, mask, predicate="within", how="inner")
    return joined.rename(columns={"geoid": "county_geoid"})


def _gda_id(value: object) -> str | None:
    """GDA_ID is read as a float; render it as a clean integer string."""
    if value is None or pd.isna(value):
        return None
    return str(int(value))


def ingest_usmin(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download + clip + store USMIN features for ``region``. Idempotent.

    Returns the number of feature rows written.
    """
    Base.metadata.create_all(engine)
    gdf = load_region_usmin(region)

    with SessionLocal() as session:
        session.execute(
            delete(UsminFeature).where(UsminFeature.county_geoid.in_(region.geoids()))
        )
        for row in gdf.itertuples(index=False):
            session.add(
                UsminFeature(
                    gda_id=_gda_id(row.GDA_ID),
                    county_geoid=str(row.county_geoid),
                    ftr_type=na_to_none(row.FTR_TYPE),
                    ftr_name=na_to_none(row.FTR_NAME),
                    topo_name=na_to_none(row.TOPO_NAME),
                    topo_date=na_to_none(row.TOPO_DATE),
                    remarks=na_to_none(row.REMARKS),
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(gdf)

    log.info("Ingested %d USMIN features for region '%s'", count, region.name)
    return count
