"""Ingest active BLM mining claims, clipped to the focus area.

The BLM Mineral & Land Records System (MLRS) publishes mining-claim cases as
polygons, geocoded from each case's Public Land Survey System (PLSS) legal
description. We pull the ACTIVE claims layer (layer 1 of the MapServer): ground a
third party currently holds mineral rights to on public land. This realizes the
"active claims" layer the PRD previously deferred to a portal link — it lets a
prospector see which ground is already staked before planning a trip.

Source: BLM MiningClaims_PUBLIC MapServer (gis.blm.gov/nlsdb), layer 1 "Active
Mining Claims". License: public domain (US Government work, 17 U.S.C. §105).
Geometry is PLSS-approximate — informational only; claim / land-status answers
must carry the disclaimer.
"""

from __future__ import annotations

import logging

import geopandas as gpd
from geoalchemy2.shape import from_shape
from sqlalchemy import delete

from prospector.db.base import Base, SessionLocal, engine
from prospector.db.models import MiningClaim
from prospector.ingest.arcgis import fetch_features
from prospector.ingest.census import load_region_counties
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.util import na_to_float, na_to_none, to_multipolygon

log = logging.getLogger(__name__)

WGS84 = 4326

#: BLM MiningClaims_PUBLIC MapServer, layer 1 = "Active Mining Claims" (polygons).
ACTIVE_CLAIMS_QUERY_URL = (
    "https://gis.blm.gov/nlsdb/rest/services/Mining_Claims/MiningClaims/MapServer/1/query"
)
#: Source column -> model column (verified against the live layer schema 2026-06).
_CLAIM_FIELDS: dict[str, str] = {
    "CSE_NR": "serial_nr",
    "CSE_NAME": "claim_name",
    "BLM_PROD": "claim_type",
    "REC_TYPE_CSE_GRP": "case_group",
    "CSE_DISP": "case_disp",
    "RCRD_ACRS": "acres",
}
#: Layer maxRecordCount is 2000; stay under it so each page is a light request.
_CLAIMS_PAGE = 1000


def _clean(value: object) -> str | None:
    """Strip and collapse whitespace (incl. stray newlines) in a source string.

    BLM text fields carry inconsistent whitespace — e.g. a trailing newline on
    some ``case_group`` values — which would render as a broken line in popups.
    """
    s = na_to_none(value)
    return " ".join(s.split()) if s else s


def _clean_title(value: object) -> str | None:
    """Whitespace-clean a source string and Title-Case it.

    BLM mixes casing on ``claim_type`` (``Lode Claim`` vs ``LODE CLAIM``); this
    makes it read uniformly. Not used on names/serials (Title-casing would mangle
    e.g. ``RADIUM-002``).
    """
    s = _clean(value)
    return s.title() if s else s


def _county_mask(region: DownloadRegion):
    """(bbox, dissolved-union geometry) for the region's counties, in WGS84."""
    counties = load_region_counties(region)
    return counties.total_bounds, counties.geometry.union_all()


def load_region_claims(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Load active mining-claim polygons clipped to ``region``'s counties (WGS84)."""
    bbox, mask = _county_mask(region)
    features = fetch_features(
        ACTIVE_CLAIMS_QUERY_URL,
        bbox,
        out_fields=",".join(_CLAIM_FIELDS),
        order_by="OBJECTID",
        page=_CLAIMS_PAGE,
    )
    if not features:
        return gpd.GeoDataFrame(columns=[*_CLAIM_FIELDS.values(), "geometry"], crs=WGS84)

    gdf = gpd.GeoDataFrame.from_features(features, crs=WGS84)
    clipped = gpd.clip(gdf, mask, keep_geom_type=True)
    clipped = clipped[clipped.geometry.notna() & ~clipped.geometry.is_empty].copy()
    clipped["geometry"] = clipped.geometry.apply(to_multipolygon)
    clipped = clipped[clipped.geometry.notna()].copy()
    return clipped.rename(columns=_CLAIM_FIELDS)


def ingest_claims(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download (REST) + clip + store active BLM mining claims. Idempotent."""
    Base.metadata.create_all(engine)
    gdf = load_region_claims(region)

    with SessionLocal() as session:
        session.execute(delete(MiningClaim).where(MiningClaim.state_fips == region.state_fips))
        for row in gdf.itertuples(index=False):
            session.add(
                MiningClaim(
                    state_fips=region.state_fips,
                    serial_nr=_clean(getattr(row, "serial_nr", None)),
                    claim_name=_clean(getattr(row, "claim_name", None)),
                    claim_type=_clean_title(getattr(row, "claim_type", None)),
                    case_group=_clean(getattr(row, "case_group", None)),
                    case_disp=_clean(getattr(row, "case_disp", None)),
                    acres=na_to_float(getattr(row, "acres", None)),
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(gdf)

    log.info("Ingested %d active mining claims for region '%s'", count, region.name)
    return count
