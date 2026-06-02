"""Download US county boundaries (the clip mask) from Census TIGER/Line.

The clip mask is "dataset zero": every other source layer is clipped to the
union of the counties in a `DownloadRegion`. We use the Census *cartographic
boundary* file (generalized 1:500k) rather than full-resolution TIGER — it's an
order of magnitude smaller and plenty precise for clipping.

Source: US Census Bureau, 2023 Cartographic Boundary Files (county, 500k).
License: public domain (US Government work, 17 U.S.C. §105).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import geopandas as gpd
import httpx
from geoalchemy2.shape import from_shape
from shapely.geometry import MultiPolygon
from sqlalchemy import delete

from prospector.db.base import Base, SessionLocal, engine
from prospector.db.models import County as CountyRow
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.storage import RAW_DIR, ensure_dir

log = logging.getLogger(__name__)

COUNTY_BOUNDARIES_URL = (
    "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip"
)
_LOCAL_ZIP = RAW_DIR / "census" / "cb_2023_us_county_500k.zip"
WGS84 = 4326


def download_county_boundaries(*, force: bool = False) -> Path:
    """Download the national county boundary zip to local cache; return its path.

    Cached: skips the download if the file already exists unless ``force=True``.
    """
    if _LOCAL_ZIP.exists() and not force:
        log.info("County boundaries already cached at %s", _LOCAL_ZIP)
        return _LOCAL_ZIP

    ensure_dir(_LOCAL_ZIP.parent)
    log.info("Downloading county boundaries from %s", COUNTY_BOUNDARIES_URL)
    # Download to a .part file, then atomically rename on success — so an
    # interrupted download can never leave a truncated file in the cache path
    # that later runs would silently reuse.
    part = _LOCAL_ZIP.with_name(_LOCAL_ZIP.name + ".part")
    try:
        with httpx.stream(
            "GET", COUNTY_BOUNDARIES_URL, follow_redirects=True, timeout=120
        ) as r:
            r.raise_for_status()
            with open(part, "wb") as f:
                for chunk in r.iter_bytes(chunk_size=1 << 16):
                    f.write(chunk)
        os.replace(part, _LOCAL_ZIP)
    finally:
        part.unlink(missing_ok=True)
    log.info("Saved %s (%d bytes)", _LOCAL_ZIP, _LOCAL_ZIP.stat().st_size)
    return _LOCAL_ZIP


def load_region_counties(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Load the chosen counties for ``region`` as a GeoDataFrame in WGS84.

    Reads the national file, filters to the region's GEOIDs, reprojects to 4326,
    and normalizes geometries to MultiPolygon.
    """
    zip_path = download_county_boundaries()
    gdf = gpd.read_file(zip_path)
    wanted = set(region.geoids())
    gdf = gdf[gdf["GEOID"].isin(wanted)].copy()

    missing = wanted - set(gdf["GEOID"])
    if missing:
        raise ValueError(f"County GEOIDs not found in Census data: {sorted(missing)}")

    gdf = gdf.to_crs(epsg=WGS84)
    gdf["geometry"] = gdf["geometry"].apply(
        lambda g: g if g.geom_type == "MultiPolygon" else MultiPolygon([g])
    )
    return gdf[["GEOID", "NAME", "STATEFP", "geometry"]].rename(
        columns={"GEOID": "geoid", "NAME": "name", "STATEFP": "state_fips"}
    )


def ingest_counties(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download + load + store the region's counties in PostGIS. Idempotent.

    Returns the number of county rows written.
    """
    Base.metadata.create_all(engine)
    gdf = load_region_counties(region)

    with SessionLocal() as session:
        session.execute(delete(CountyRow).where(CountyRow.geoid.in_(region.geoids())))
        for row in gdf.itertuples(index=False):
            session.add(
                CountyRow(
                    geoid=row.geoid,
                    name=row.name,
                    state_fips=row.state_fips,
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(gdf)

    log.info("Ingested %d counties for region '%s'", count, region.name)
    return count
