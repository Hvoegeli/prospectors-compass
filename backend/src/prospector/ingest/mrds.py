"""Ingest USGS MRDS (Mineral Resources Data System) mine/prospect points.

National point dataset of mine locations, commodities, and development status.
We download the national CSV once (kept local), build point geometries, and
spatially join to a region's county polygons — that join both clips to the
focus area and assigns each site its authoritative county.

Source: USGS Mineral Resources Data System, https://mrdata.usgs.gov/mrds/.
License: public domain (US Government work, 17 U.S.C. §105).
"""

from __future__ import annotations

import logging
import zipfile
from pathlib import Path

import geopandas as gpd
import pandas as pd
from geoalchemy2.shape import from_shape
from sqlalchemy import delete

from prospector.db.base import Base, SessionLocal, engine
from prospector.db.models import MrdsSite
from prospector.ingest.census import load_region_counties
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.storage import RAW_DIR, download_file

log = logging.getLogger(__name__)

MRDS_URL = "https://mrdata.usgs.gov/mrds/mrds-csv.zip"
_LOCAL_ZIP = RAW_DIR / "mrds" / "mrds-csv.zip"
_CSV_NAME = "mrds.csv"
WGS84 = 4326

_USECOLS = [
    "dep_id",
    "url",
    "site_name",
    "latitude",
    "longitude",
    "commod1",
    "commod2",
    "commod3",
    "dev_stat",
]


def download_mrds(*, force: bool = False) -> Path:
    """Download the national MRDS CSV zip to local cache; return its path."""
    return download_file(MRDS_URL, _LOCAL_ZIP, force=force)


def load_region_mrds(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Load MRDS sites clipped to ``region``'s counties, tagged with county GEOID.

    Reads the national CSV, builds WGS84 points, and spatial-joins to the
    region's county polygons (predicate "within"), which both filters to the
    focus area and assigns ``county_geoid``.
    """
    zip_path = download_mrds()
    with zipfile.ZipFile(zip_path) as zf, zf.open(_CSV_NAME) as f:
        df = pd.read_csv(f, usecols=_USECOLS, dtype=str, low_memory=False)

    # Coordinates are required to place a point; drop rows without them.
    df["latitude"] = pd.to_numeric(df["latitude"], errors="coerce")
    df["longitude"] = pd.to_numeric(df["longitude"], errors="coerce")
    df = df.dropna(subset=["dep_id", "latitude", "longitude"])

    points = gpd.GeoDataFrame(
        df,
        geometry=gpd.points_from_xy(df["longitude"], df["latitude"]),
        crs=WGS84,
    )
    mask = load_region_counties(region)[["geoid", "geometry"]]
    joined = gpd.sjoin(points, mask, predicate="within", how="inner")
    joined = joined.rename(columns={"geoid": "county_geoid"})
    # A point on a shared boundary could (rarely) match >1 county; keep one.
    joined = joined.drop_duplicates(subset="dep_id")
    keep = [
        "dep_id",
        "site_name",
        "url",
        "county_geoid",
        "dev_stat",
        "commod1",
        "commod2",
        "commod3",
        "geometry",
    ]
    return joined[keep]


def _clean(value: object) -> str | None:
    """Pandas NaN -> None; everything else -> str (DB stores text or NULL)."""
    return None if value is None or pd.isna(value) else str(value)


def ingest_mrds(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download + clip + store MRDS sites for ``region`` in PostGIS. Idempotent.

    Returns the number of site rows written.
    """
    Base.metadata.create_all(engine)
    gdf = load_region_mrds(region)

    with SessionLocal() as session:
        session.execute(
            delete(MrdsSite).where(MrdsSite.county_geoid.in_(region.geoids()))
        )
        for row in gdf.itertuples(index=False):
            session.add(
                MrdsSite(
                    dep_id=str(row.dep_id),
                    site_name=_clean(row.site_name),
                    url=_clean(row.url),
                    county_geoid=str(row.county_geoid),
                    dev_stat=_clean(row.dev_stat),
                    commod1=_clean(row.commod1),
                    commod2=_clean(row.commod2),
                    commod3=_clean(row.commod3),
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(gdf)

    log.info("Ingested %d MRDS sites for region '%s'", count, region.name)
    return count
