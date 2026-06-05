"""Ingest USGS NHD stream / river / creek flowlines, clipped to the focus area.

High-resolution NHD Flowline (TNM `nhd/MapServer/6`, "Flowline - Large Scale"),
filtered to PERENNIAL MAIN channels (FType 460 StreamRiver, fcode 46006, with a
visibility-filter threshold) — gold panning/sluicing needs year-round water, so
seasonal and hair-thin capillary streams are dropped (keeps the layer compact and
prospecting-relevant). bbox-queried + paginated, then clipped to the county union.
Placer gold follows drainages, so trace a creek downhill from a lode/district.

Source: USGS National Hydrography Dataset. License: public domain (US Gov work).
"""

from __future__ import annotations

import logging

import geopandas as gpd
from geoalchemy2.shape import from_shape
from sqlalchemy import delete

from prospector.db.base import Base, SessionLocal, engine
from prospector.db.models import Stream
from prospector.ingest.arcgis import fetch_features
from prospector.ingest.census import load_region_counties
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.util import na_to_none, to_multilinestring

log = logging.getLogger(__name__)

WGS84 = 4326
#: USGS NHD high-res Flowline (TNM). Layer 6 = "Flowline - Large Scale".
NHD_FLOWLINE_QUERY = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query"
_OUT_FIELDS = "permanent_identifier,gnis_name,fcode,ftype"
#: FType 460 = StreamRiver (natural channels only — excludes canals, pipelines,
#: artificial paths). fcode=46006 keeps PERENNIAL streams: gold panning/sluicing
#: needs year-round water, so seasonal (intermittent/ephemeral) channels are
#: dropped. visibilityfilter>=100000 keeps MAIN channels, dropping hair-thin
#: capillary tributaries. (Intermittent streams are a possible future toggle —
#: relevant only for non-gold minerals washed down in past flows.)
_WHERE = "ftype=460 AND fcode=46006 AND visibilityfilter>=100000"
#: Detailed line geometry; small pages keep each request light (the TNM hydro
#: service 504s on large geometry pulls — same reason as the WBD ingest).
_PAGE = 200

#: NHD StreamRiver fcode -> flow regime (for display + styling).
_FCODE_FLOW: dict[int, str] = {46006: "Perennial", 46003: "Intermittent"}


def _flow_type(fcode: object) -> str | None:
    """Decode an NHD fcode to a flow regime; None for unspecified (46000)."""
    try:
        return _FCODE_FLOW.get(int(fcode))
    except (TypeError, ValueError):
        return None


def load_region_streams(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Load NHD stream flowlines clipped to ``region``'s counties (WGS84)."""
    counties = load_region_counties(region)
    bbox = tuple(counties.total_bounds)
    mask = counties.geometry.union_all()

    features = fetch_features(
        NHD_FLOWLINE_QUERY,
        bbox,
        out_fields=_OUT_FIELDS,
        order_by="permanent_identifier",
        where=_WHERE,
        page=_PAGE,
        retries=6,  # the TNM hydro service 504s under sustained load — ride it out
    )
    if not features:
        return gpd.GeoDataFrame(
            columns=["permanent_identifier", "gnis_name", "fcode", "geometry"], crs=WGS84
        )

    gdf = gpd.GeoDataFrame.from_features(features, crs=WGS84)
    clipped = gpd.clip(gdf, mask, keep_geom_type=True)
    clipped = clipped[clipped.geometry.notna() & ~clipped.geometry.is_empty].copy()
    clipped["geometry"] = clipped.geometry.apply(to_multilinestring)
    return clipped[clipped.geometry.notna()].copy()


def ingest_streams(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download (REST) + clip + store NHD stream flowlines. Idempotent.

    Re-ingest is scoped by ``state_fips``. Returns the number of rows written.
    """
    Base.metadata.create_all(engine)
    gdf = load_region_streams(region)

    with SessionLocal() as session:
        session.execute(delete(Stream).where(Stream.state_fips == region.state_fips))
        for row in gdf.itertuples(index=False):
            session.add(
                Stream(
                    state_fips=region.state_fips,
                    nhd_id=na_to_none(getattr(row, "permanent_identifier", None)),
                    name=na_to_none(getattr(row, "gnis_name", None)),
                    flow_type=_flow_type(getattr(row, "fcode", None)),
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(gdf)

    log.info("Ingested %d NHD stream flowlines for region '%s'", count, region.name)
    return count
