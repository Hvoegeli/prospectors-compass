"""Ingest USGS state geologic map-unit polygons, clipped to the focus area.

Per-state shapefile from the USGS State Geologic Map Compilation. Polygons carry
a `UNIT_LINK` that joins to the package's unit lookup CSV for the real geology
(unit name, age, lithology, description). Because a geologic unit spans many
counties, we clip (intersect) the polygons against the *dissolved union* of the
region's counties rather than tagging each with one county.

Source: USGS State Geologic Map Compilation, https://mrdata.usgs.gov/geology/state/.
License: public domain (US Government work, 17 U.S.C. §105).
"""

from __future__ import annotations

import io
import logging
import zipfile
from pathlib import Path

import geopandas as gpd
import pandas as pd
from geoalchemy2.shape import from_shape
from shapely.geometry import MultiPolygon
from sqlalchemy import delete

from prospector.db.base import Base, SessionLocal, engine
from prospector.db.models import GeologicUnit
from prospector.ingest.census import load_region_counties
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.storage import RAW_DIR, download_file
from prospector.ingest.util import na_to_none

log = logging.getLogger(__name__)

GEOLOGY_URL_TEMPLATE = "https://mrdata.usgs.gov/geology/state/shp/{abbrev}.zip"
WGS84 = 4326

# Columns pulled from the unit lookup CSV (joined on unit_link).
_UNIT_COLS = ["unit_link", "unit_name", "unit_age", "unitdesc", "rocktype1", "rocktype2", "rocktype3"]


def _zip_path(region: DownloadRegion) -> Path:
    return RAW_DIR / "geology" / f"{region.state_abbrev}.zip"


def download_geology(region: DownloadRegion = DEFAULT_REGION, *, force: bool = False) -> Path:
    """Download the per-state geology zip to local cache; return its path."""
    url = GEOLOGY_URL_TEMPLATE.format(abbrev=region.state_abbrev)
    return download_file(url, _zip_path(region), force=force)


def load_region_geology(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Load geologic unit polygons clipped to ``region``'s counties.

    Reads the state polygons, enriches them from the unit lookup CSV, and clips
    to the dissolved union of the region's county polygons.
    """
    zip_path = download_geology(region)
    abbrev = region.state_abbrev

    poly = gpd.read_file(f"zip://{zip_path}!{abbrev}_geol_poly.shp")
    if poly.crs is None:
        poly = poly.set_crs(epsg=WGS84)
    poly = poly.to_crs(epsg=WGS84)

    with zipfile.ZipFile(zip_path) as zf:
        units = pd.read_csv(io.BytesIO(zf.read(f"{abbrev}_units.csv")), dtype=str)
    units = units[_UNIT_COLS].drop_duplicates(subset="unit_link")
    poly = poly.merge(units, how="left", left_on="UNIT_LINK", right_on="unit_link")

    mask_union = load_region_counties(region).geometry.union_all()
    clipped = gpd.clip(poly, mask_union, keep_geom_type=True)
    clipped = clipped[clipped.geometry.notna() & ~clipped.geometry.is_empty].copy()
    clipped["geometry"] = clipped.geometry.apply(
        lambda g: g if g.geom_type == "MultiPolygon" else MultiPolygon([g])
    )
    return clipped


def ingest_geology(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download + clip + store geologic units for ``region`` in PostGIS. Idempotent.

    Re-ingest is scoped by ``state_fips`` (geology is downloaded per state).
    Returns the number of polygon rows written.
    """
    Base.metadata.create_all(engine)
    gdf = load_region_geology(region)

    with SessionLocal() as session:
        session.execute(
            delete(GeologicUnit).where(GeologicUnit.state_fips == region.state_fips)
        )
        for row in gdf.itertuples(index=False):
            session.add(
                GeologicUnit(
                    state_fips=region.state_fips,
                    unit_link=na_to_none(row.UNIT_LINK),
                    orig_label=na_to_none(row.ORIG_LABEL),
                    generalized_lith=na_to_none(row.GENERALIZE),
                    unit_name=na_to_none(row.unit_name),
                    unit_age=na_to_none(row.unit_age),
                    rocktype1=na_to_none(row.rocktype1),
                    rocktype2=na_to_none(row.rocktype2),
                    rocktype3=na_to_none(row.rocktype3),
                    unit_desc=na_to_none(row.unitdesc),
                    url=na_to_none(row.URL),
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(gdf)

    log.info("Ingested %d geologic units for region '%s'", count, region.name)
    return count
