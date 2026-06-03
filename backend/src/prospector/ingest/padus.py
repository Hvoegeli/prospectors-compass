"""Ingest land surface-manager/owner polygons from USGS PAD-US, clipped to the
focus area.

Source: USGS PAD-US 4.1 (Protected Areas Database), per-state GeoDatabase. We use
the **Fee** feature class — fee ownership/management of the underlying land —
which (by area) is dominated by the federal lands a prospector cares about
(Forest Service, BLM). This is a deliberate, surfaced substitution for BLM's own
ArcGIS endpoints: PAD-US carries the same manager/owner info in a clean,
per-state, public-domain form consistent with our other USGS layers.

Deviation noted in docs/DATA_SOURCES.md. Land status is INFORMATIONAL only — the
disclaimer + no go/no-go rule are enforced at the agent layer, not here.
License: public domain (US Government work, 17 U.S.C. §105).
"""

from __future__ import annotations

import logging
import zipfile
from pathlib import Path

import geopandas as gpd
from geoalchemy2.shape import from_shape
from shapely.geometry import MultiPolygon
from sqlalchemy import delete

from prospector.db.base import Base, SessionLocal, engine
from prospector.db.models import LandOwnership
from prospector.ingest.census import load_region_counties
from prospector.ingest.focus_area import DEFAULT_REGION, DownloadRegion
from prospector.ingest.storage import RAW_DIR, download_file, ensure_dir
from prospector.ingest.util import na_to_none

log = logging.getLogger(__name__)

# Region-parameterizable ScienceBase download (itemId fixed; state varies).
_PADUS_ITEM = "6759abcfd34edfeb8710a004"
PADUS_URL_TEMPLATE = (
    f"https://www.sciencebase.gov/catalog/file/get/{_PADUS_ITEM}"
    "?name=PADUS4_1_State_{abbrev}_GDB_KMZ.zip"
)
WGS84 = 4326


def _zip_path(region: DownloadRegion) -> Path:
    return RAW_DIR / "padus" / f"PADUS4_1_State_{region.state_abbrev}_GDB_KMZ.zip"


def _gdb_dir(region: DownloadRegion) -> Path:
    # NB: USGS naming is inconsistent — the .gdb has no underscore before the
    # state ("PADUS4_1_StateCO.gdb") while the Fee layer does ("..._State_CO").
    return RAW_DIR / "padus" / f"PADUS4_1_State{region.state_abbrev}.gdb"


def _fee_layer(region: DownloadRegion) -> str:
    return f"PADUS4_1Fee_State_{region.state_abbrev}"


def download_padus(region: DownloadRegion = DEFAULT_REGION, *, force: bool = False) -> Path:
    """Download + extract the per-state PAD-US GDB. Returns the .gdb dir path.

    FileGDB-in-zip reads are unreliable, so we extract the .gdb members to disk
    (skipping the large KMZ siblings) and read from the extracted directory.
    """
    url = PADUS_URL_TEMPLATE.format(abbrev=region.state_abbrev)
    zip_path = download_file(url, _zip_path(region), force=force)

    gdb = _gdb_dir(region)
    if not gdb.exists() or force:
        ensure_dir(gdb.parent)
        with zipfile.ZipFile(zip_path) as zf:
            members = [m for m in zf.namelist() if m.startswith(f"{gdb.name}/")]
            zf.extractall(gdb.parent, members=members)
        log.info("Extracted %s (%d files)", gdb, len(members))
    return gdb


def _to_multipolygon(geom: object) -> MultiPolygon | None:
    """Coerce a (possibly mixed) geometry to MultiPolygon, dropping non-areal parts.

    `make_valid` can turn a self-intersecting polygon into a GeometryCollection,
    so we keep only the polygonal pieces and re-wrap them.
    """
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type == "MultiPolygon":
        return geom
    if geom.geom_type == "Polygon":
        return MultiPolygon([geom])
    parts: list = []
    for g in getattr(geom, "geoms", []):
        if g.geom_type == "Polygon":
            parts.append(g)
        elif g.geom_type == "MultiPolygon":
            parts.extend(g.geoms)
    return MultiPolygon(parts) if parts else None


def load_region_ownership(region: DownloadRegion = DEFAULT_REGION) -> gpd.GeoDataFrame:
    """Load PAD-US Fee polygons clipped to ``region``'s counties.

    Reprojects from PAD-US Albers to WGS84, repairs invalid source geometries
    (PAD-US has self-intersecting / nested-shell polygons), keeps the decoded
    (`d_`) attribute fields, and clips to the dissolved union of the counties.
    """
    gdb = download_padus(region)
    fee = gpd.read_file(gdb, layer=_fee_layer(region))
    fee = fee.to_crs(epsg=WGS84)
    # Repair invalid geometries BEFORE clipping so the clip gets clean input.
    fee["geometry"] = fee.geometry.make_valid()

    keep = {
        "d_Mang_Name": "manager_name",
        "d_Mang_Type": "manager_type",
        "d_Own_Type": "owner_type",
        "Unit_Nm": "unit_name",
        "d_Pub_Access": "public_access",
        "Src_Date": "as_of_date",
    }
    fee = fee[[*keep, "geometry"]].rename(columns=keep)

    mask_union = load_region_counties(region).geometry.union_all()
    clipped = gpd.clip(fee, mask_union, keep_geom_type=True)
    clipped["geometry"] = clipped.geometry.apply(_to_multipolygon)
    return clipped[clipped.geometry.notna()].copy()


def ingest_ownership(region: DownloadRegion = DEFAULT_REGION) -> int:
    """Download + clip + store land-ownership polygons for ``region``. Idempotent.

    Re-ingest is scoped by ``state_fips``. Returns the number of rows written.
    """
    Base.metadata.create_all(engine)
    gdf = load_region_ownership(region)

    with SessionLocal() as session:
        session.execute(
            delete(LandOwnership).where(LandOwnership.state_fips == region.state_fips)
        )
        for row in gdf.itertuples(index=False):
            session.add(
                LandOwnership(
                    state_fips=region.state_fips,
                    manager_name=na_to_none(row.manager_name),
                    manager_type=na_to_none(row.manager_type),
                    owner_type=na_to_none(row.owner_type),
                    unit_name=na_to_none(row.unit_name),
                    public_access=na_to_none(row.public_access),
                    as_of_date=na_to_none(row.as_of_date),
                    geom=from_shape(row.geometry, srid=WGS84),
                )
            )
        session.commit()
        count = len(gdf)

    log.info("Ingested %d land-ownership polygons for region '%s'", count, region.name)
    return count
