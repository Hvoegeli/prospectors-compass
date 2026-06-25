"""Ingest airborne gamma-ray (radiometric) grids, clipped to the focus area.

v1 source: USGS Bayesian-modeled NURE airborne radiometric prediction grids for
the conterminous US (DOI 10.5066/P9YEAFHI, CC0 public domain). We pull the
West-Central US tile (covers Colorado) for equivalent thorium (eTh) and potassium
(K), keep only surveyed cells, merge them on the shared grid, and store points
carrying eTh (ppm), K (%), the Th/K ratio, and the model's eTh-exceedance
probability.

Thorium highs mark fractionated, "fertile" granites — the parent rock of
gem-bearing pegmatites — so this feeds the lode engine's 'granite fertility'
factor (see engine/scoring.py). Coarse (~1 km); a Park County proof-of-concept
(2026-06-24) showed known gem/pegmatite sites sit at the ~80th percentile of eTh
vs county background.

UPGRADE PATH: the 200 m USGS Earth MRI survey (Colorado Mineral Belt, Northeast
Block, 2024; DOI 10.5066/P144WOYP) — same table, finer grid. That release is a
browser-only 4 GB download (ScienceBase gates the cloud file behind a JS download
manager), so it is not wired as an automatic source here.

License: public domain (US Government work / CC0). See docs/DATA_SOURCES.md.
"""

from __future__ import annotations

import logging

import geopandas as gpd
import pandas as pd
from geoalchemy2.shape import from_shape
from shapely.geometry import Point
from sqlalchemy import delete

from prospector.db.base import Base, SessionLocal, engine
from prospector.db.models import Radiometric
from prospector.ingest.census import load_region_counties
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.storage import RAW_DIR, download_file
from prospector.ingest.util import na_to_float

log = logging.getLogger(__name__)

WGS84 = 4326
_SOURCE = "NURE-Bayesian"

# USGS Bayesian NURE grids (DOI 10.5066/P9YEAFHI). The West-Central US tile covers
# Colorado. These are direct ScienceBase file URLs for the public-domain __disk__
# files — scriptable, unlike the browser-gated Earth MRI release.
_SB = "https://www.sciencebase.gov/catalog/file/get/5dd2f264e4b0695797628351"
_ETH_URL = f"{_SB}?f=__disk__35/5f/e6/355fe63c0f661028fa76f91b726547fef137f300"
_K_URL = f"{_SB}?f=__disk__e5/56/b0/e556b0beac473ffcf3dfd18716b67950194c52f9"
_ETH_ZIP = RAW_DIR / "nure" / "Predictions_eTh_WestCentUS.zip"
_K_ZIP = RAW_DIR / "nure" / "Predictions_K_WestCentUS.zip"
_ETH_SHP = "Predictions_eTh_WestCentUS.shp"
_K_SHP = "Predictions_K_WestCentUS.shp"


def _load_surveyed(zip_path, shp: str, value_col: str, out_col: str) -> pd.DataFrame:
    """Read one NURE grid shapefile → DataFrame of surveyed cells only.

    Keeps the Albers grid keys (``easting``/``northing``, identical across the eTh
    and K tiles, so they join exactly), the NAD83 ``long``/``lat`` (≈ WGS84), the
    value column, and the model exceedance ``prob``. ``RASTERVALU == 1`` marks
    cells outside the NURE survey (no data) — dropped.
    """
    g = gpd.read_file(f"zip://{zip_path}!{shp}")
    g = g[g["RASTERVALU"] == 0]
    return pd.DataFrame({
        "k_e": g["easting"].round(0),
        "k_n": g["northing"].round(0),
        "long": g["long"].astype(float),
        "lat": g["lat"].astype(float),
        out_col: g[value_col].astype(float),
        "prob": g["prob"].astype(float),
    })


def load_region_radiometric(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Download + merge the eTh and K NURE grids, clipped to ``region``'s counties (WGS84)."""
    eth_zip = download_file(_ETH_URL, _ETH_ZIP)
    k_zip = download_file(_K_URL, _K_ZIP)

    counties = load_region_counties(region)
    minx, miny, maxx, maxy = counties.total_bounds
    mask = counties.geometry.union_all()

    eth = _load_surveyed(eth_zip, _ETH_SHP, "Y_mean_ppm", "eth_ppm")
    kdf = _load_surveyed(k_zip, _K_SHP, "Y_mean_per", "k_pct")[["k_e", "k_n", "k_pct"]]

    # Cheap bbox prefilter (on the NAD83 long/lat columns) before the spatial clip.
    eth = eth[(eth.long >= minx) & (eth.long <= maxx) & (eth.lat >= miny) & (eth.lat <= maxy)]
    merged = eth.merge(kdf, on=["k_e", "k_n"], how="inner")
    if merged.empty:
        return gpd.GeoDataFrame(
            columns=["eth_ppm", "k_pct", "th_k", "prob", "geometry"], crs=WGS84
        )

    # Th/K only where potassium is positive (avoid div-by-zero → NULL).
    merged["th_k"] = merged.eth_ppm / merged.k_pct.where(merged.k_pct > 0)
    gdf = gpd.GeoDataFrame(
        merged, geometry=[Point(xy) for xy in zip(merged.long, merged.lat)], crs=WGS84
    )
    return gdf[gdf.within(mask)].copy()


def ingest_radiometric(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download + clip + store radiometric grid points. Idempotent (per state_fips)."""
    Base.metadata.create_all(engine)
    gdf = load_region_radiometric(region)

    with SessionLocal() as session:
        session.execute(delete(Radiometric).where(Radiometric.state_fips == region.state_fips))
        for row in gdf.itertuples(index=False):
            session.add(
                Radiometric(
                    state_fips=region.state_fips,
                    eth_ppm=na_to_float(row.eth_ppm),
                    k_pct=na_to_float(row.k_pct),
                    th_k=na_to_float(row.th_k),
                    exceed_prob=na_to_float(row.prob),
                    source=_SOURCE,
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(gdf)

    log.info("Ingested %d radiometric grid points for region '%s'", count, region.name)
    return count
