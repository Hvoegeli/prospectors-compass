"""Ingest Colorado Geological Survey (CGS) datasets, clipped to the focus area.

Three layers, all from CGS, all clipped to the dissolved union of the region's
counties:

  districts  : Historic Metal Mining Districts (ON-007-08D) — named polygons of
               proven-productive metal-mining ground, with a link to the CGS
               county report. The highest-signal prospecting layer.
  potential  : Mineral Resource Potential Derivative Map (ON-007-03) — geologic
               units rated 1/2/3 for favorability per commodity, pulled from the
               CGS ArcGIS MapServer. We keep only prospecting-relevant targets.
  aml        : Abandoned Mine Land hazards (ON-008-04) — mine openings and
               tailings piles as hazard points (PRD hazard-surfacing requirement).

License: CGS data is published for public use; see docs/DATA_SOURCES.md.
"""

from __future__ import annotations

import logging

import geopandas as gpd
from geoalchemy2.shape import from_shape
from shapely.geometry import Point
from sqlalchemy import delete

from prospector.db.base import Base, SessionLocal, engine
from prospector.db.models import AmlHazard, MineralPotential, MiningDistrict
from prospector.ingest.arcgis import fetch_features
from prospector.ingest.census import load_region_counties
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.storage import RAW_DIR, download_file
from prospector.ingest.util import na_to_none, to_multipolygon

log = logging.getLogger(__name__)

WGS84 = 4326

# --- Historic Metal Mining Districts (ON-007-08D) --------------------------------
DISTRICTS_URL = "https://coloradogeologicalsurvey.org/Docs/Pubs/ON-007-08D-v20201112.zip"
_DISTRICTS_ZIP = RAW_DIR / "cgs" / "ON-007-08D-v20201112.zip"
_DISTRICTS_SHP = (
    "ON-007-08D-GIS_Data-v20201112/Colorado_Historic_Metal_Mining_Districts.shp"
)

# --- Mineral Resource Potential Derivative Map (ON-007-03), CGS ArcGIS MapServer --
POTENTIAL_QUERY_URL = (
    "https://cgsarcimage.mines.edu/arcgis/rest/services/cgs_services/"
    "Mineral_Resource_Potential_Derivative_Map/MapServer/10/query"
)
# Source column -> model column. Only prospecting-relevant targets (the
# industrial/aggregate/coal commodities are not prospecting targets).
_POTENTIAL_FIELDS: dict[str, str] = {
    "MET_Au_P": "au_placer",
    "IM_PEGM": "pegmatite",
    "IM_CRDM": "corundum",
    "MET_REE": "rare_earth",
    "IM_FLUO": "fluorite",
    "FMT": "formation",
    "QUAD": "quad",
}
_POTENTIAL_WHERE = "MET_Au_P>0 OR IM_PEGM>0 OR IM_CRDM>0 OR MET_REE>0 OR IM_FLUO>0"
_POTENTIAL_PAGE = 1000

# --- Abandoned Mine Land hazards (ON-008-04) -------------------------------------
AML_URL = "https://coloradogeologicalsurvey.org/wp-content/uploads/2025/07/ON-008-04.zip"
_AML_ZIP = RAW_DIR / "cgs" / "ON-008-04.zip"
_AML_GDB_INNER = "ON-008-04 FINAL FILES/GIS_Data (gdb files)/USFS AMLI.gdb"


def _county_mask(region: DownloadRegion):
    """(bbox, dissolved-union geometry) for the region's counties, in WGS84."""
    counties = load_region_counties(region)
    return counties.total_bounds, counties.geometry.union_all()


# ----------------------------------------------------------------------------------
# Historic Metal Mining Districts
# ----------------------------------------------------------------------------------
def load_region_districts(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Load mining-district polygons clipped to ``region``'s counties (WGS84)."""
    zip_path = download_file(DISTRICTS_URL, _DISTRICTS_ZIP)
    _, mask = _county_mask(region)

    gdf = gpd.read_file(f"zip://{zip_path}!{_DISTRICTS_SHP}").to_crs(epsg=WGS84)
    clipped = gpd.clip(gdf, mask, keep_geom_type=True)
    clipped = clipped[clipped.geometry.notna() & ~clipped.geometry.is_empty].copy()
    clipped["geometry"] = clipped.geometry.apply(to_multipolygon)
    return clipped[clipped.geometry.notna()].copy()


def ingest_districts(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download + clip + store historic metal-mining districts. Idempotent."""
    Base.metadata.create_all(engine)
    gdf = load_region_districts(region)

    with SessionLocal() as session:
        session.execute(
            delete(MiningDistrict).where(MiningDistrict.state_fips == region.state_fips)
        )
        for row in gdf.itertuples(index=False):
            session.add(
                MiningDistrict(
                    state_fips=region.state_fips,
                    district=na_to_none(row.District),
                    county_1=na_to_none(row.County_1),
                    county_2=na_to_none(row.County_2),
                    web_page=na_to_none(row.WebPage),
                    source=na_to_none(row.Source),
                    note=na_to_none(row.Note),
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(gdf)

    log.info("Ingested %d mining districts for region '%s'", count, region.name)
    return count


# ----------------------------------------------------------------------------------
# Mineral Resource Potential (ArcGIS MapServer, paginated)
# ----------------------------------------------------------------------------------
def load_region_potential(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Load mineral-potential polygons clipped to ``region``'s counties (WGS84)."""
    bbox, mask = _county_mask(region)
    out_fields = ",".join(c for c in _POTENTIAL_FIELDS if c not in ("FMT", "QUAD")) + ",FMT,QUAD"
    features = fetch_features(
        POTENTIAL_QUERY_URL,
        bbox,
        out_fields=out_fields,
        order_by="OBJECTID",
        where=_POTENTIAL_WHERE,
        page=_POTENTIAL_PAGE,
    )
    if not features:
        return gpd.GeoDataFrame(columns=[*_POTENTIAL_FIELDS.values(), "geometry"], crs=WGS84)

    gdf = gpd.GeoDataFrame.from_features(features, crs=WGS84)
    clipped = gpd.clip(gdf, mask, keep_geom_type=True)
    clipped = clipped[clipped.geometry.notna() & ~clipped.geometry.is_empty].copy()
    clipped["geometry"] = clipped.geometry.apply(to_multipolygon)
    clipped = clipped[clipped.geometry.notna()].copy()
    return clipped.rename(columns=_POTENTIAL_FIELDS)


def _rating(value: object) -> int | None:
    """Coerce an ArcGIS integer rating to int, treating missing/0 as None."""
    if value in (None, "", 0):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def ingest_potential(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download (REST) + clip + store mineral-resource-potential polygons. Idempotent."""
    Base.metadata.create_all(engine)
    gdf = load_region_potential(region)

    with SessionLocal() as session:
        session.execute(
            delete(MineralPotential).where(MineralPotential.state_fips == region.state_fips)
        )
        for row in gdf.itertuples(index=False):
            session.add(
                MineralPotential(
                    state_fips=region.state_fips,
                    formation=na_to_none(getattr(row, "formation", None)),
                    quad=na_to_none(getattr(row, "quad", None)),
                    au_placer=_rating(getattr(row, "au_placer", None)),
                    pegmatite=_rating(getattr(row, "pegmatite", None)),
                    corundum=_rating(getattr(row, "corundum", None)),
                    rare_earth=_rating(getattr(row, "rare_earth", None)),
                    fluorite=_rating(getattr(row, "fluorite", None)),
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(gdf)

    log.info("Ingested %d mineral-potential polygons for region '%s'", count, region.name)
    return count


# ----------------------------------------------------------------------------------
# Abandoned Mine Land hazards (mine openings + tailings piles)
# ----------------------------------------------------------------------------------
#: gdb layer -> (hazard_kind, feature-type col, env-rating col or None)
_AML_LAYERS: dict[str, tuple[str, str, str | None]] = {
    "Hole_Mine_Openings_Final": ("opening", "HTYPE", "ENV_RATING"),
    "PILE_Mine_Tailings_Final": ("tailings", "PTYPE", "ENV_RATING"),
}


def _read_aml_layer(gdb_path: str, layer: str, mask) -> gpd.GeoDataFrame:
    """Read one AML point layer, reproject to WGS84, clip to the county union."""
    gdf = gpd.read_file(gdb_path, layer=layer).to_crs(epsg=WGS84)
    clipped = gpd.clip(gdf, mask, keep_geom_type=True)
    return clipped[clipped.geometry.notna() & ~clipped.geometry.is_empty].copy()


def ingest_aml(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download + clip + store AML hazard points (openings + tailings). Idempotent."""
    Base.metadata.create_all(engine)
    zip_path = download_file(AML_URL, _AML_ZIP)
    gdb_path = f"/vsizip/{zip_path}/{_AML_GDB_INNER}"
    _, mask = _county_mask(region)

    with SessionLocal() as session:
        session.execute(delete(AmlHazard).where(AmlHazard.state_fips == region.state_fips))
        count = 0
        for layer, (kind, type_col, env_col) in _AML_LAYERS.items():
            gdf = _read_aml_layer(gdb_path, layer, mask)
            for row in gdf.itertuples(index=False):
                attrs = row._asdict()
                geom = attrs[gdf.geometry.name]
                if not isinstance(geom, Point):
                    geom = geom.representative_point()
                session.add(
                    AmlHazard(
                        state_fips=region.state_fips,
                        hazard_kind=kind,
                        feature_type=na_to_none(attrs.get(type_col)),
                        haz_rating=na_to_none(attrs.get("HAZ_RATING")),
                        env_rating=na_to_none(attrs.get(env_col)) if env_col else None,
                        comments=na_to_none(attrs.get("COMMENTS")),
                        geom=from_shape(geom, srid=WGS84),
                    )
                )
            count += len(gdf)
        session.commit()

    log.info("Ingested %d AML hazard points for region '%s'", count, region.name)
    return count
