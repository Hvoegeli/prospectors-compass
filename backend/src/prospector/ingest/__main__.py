"""CLI for local data ingestion.

    uv run python -m prospector.ingest counties   # download + load the clip mask
    uv run python -m prospector.ingest mrds        # USGS MRDS mine/prospect points
    uv run python -m prospector.ingest usmin       # USGS USMIN topo mine features
    uv run python -m prospector.ingest geology     # USGS geologic unit polygons
    uv run python -m prospector.ingest ownership   # PAD-US land manager/owner polygons
    uv run python -m prospector.ingest all         # clip mask, then every layer

Runs against the v1 default region (the I-70 corridor). Later, the county-picker
UI will pass a user-built region to these same functions.
"""

from __future__ import annotations

import argparse
import logging
import os
from datetime import datetime, timezone

from prospector.ingest.census import ingest_counties
from prospector.ingest.cgs import ingest_aml, ingest_districts, ingest_potential
from prospector.ingest.focus_area import DEFAULT_REGION
from prospector.ingest.geology import ingest_geology
from prospector.ingest.mrds import ingest_mrds
from prospector.ingest.padus import ingest_ownership
from prospector.ingest.roads import ingest_forest, ingest_roads
from prospector.ingest.storage import PROCESSED_DIR, ensure_dir
from prospector.ingest.terrain import build_basemap
from prospector.ingest.usfs_forest import ingest_forests
from prospector.ingest.usmin import ingest_usmin
from prospector.ingest.watershed import ingest_watersheds


def _run_counties() -> None:
    region = DEFAULT_REGION
    print(f"Ingesting counties for: {region.name}")
    print(f"  Counties ({len(region.counties)}): {', '.join(region.county_names())}")
    count = ingest_counties(region)
    print(f"✓ Loaded {count} counties into PostGIS table 'counties'.")


def _run_mrds() -> None:
    region = DEFAULT_REGION
    print(f"Ingesting MRDS sites for: {region.name}")
    count = ingest_mrds(region)
    print(f"✓ Loaded {count} MRDS sites into PostGIS table 'mrds_sites'.")


def _run_usmin() -> None:
    region = DEFAULT_REGION
    print(f"Ingesting USMIN features for: {region.name}")
    count = ingest_usmin(region)
    print(f"✓ Loaded {count} USMIN features into PostGIS table 'usmin_features'.")


def _run_geology() -> None:
    region = DEFAULT_REGION
    print(f"Ingesting geologic units for: {region.name}")
    count = ingest_geology(region)
    print(f"✓ Loaded {count} geologic units into PostGIS table 'geologic_units'.")


def _run_ownership() -> None:
    region = DEFAULT_REGION
    print(f"Ingesting land ownership for: {region.name}")
    count = ingest_ownership(region)
    print(f"✓ Loaded {count} land-ownership polygons into PostGIS table 'land_ownership'.")


def _run_roads() -> None:
    region = DEFAULT_REGION
    print(f"Ingesting public roads + trails for: {region.name}")
    count = ingest_roads(region)
    print(f"✓ Loaded {count} public road/trail segments into PostGIS table 'roads'.")


def _run_forest() -> None:
    region = DEFAULT_REGION
    print(f"Ingesting USFS forest roads + trails for: {region.name}")
    count = ingest_forest(region)
    print(f"✓ Loaded {count} forest road/trail segments into PostGIS table 'roads'.")


def _run_forests() -> None:
    region = DEFAULT_REGION
    print(f"Ingesting USFS Administrative Forest boundaries for: {region.name}")
    count = ingest_forests(region)
    print(f"✓ Loaded {count} forest boundaries into PostGIS table 'admin_forests'.")


def _run_districts() -> None:
    region = DEFAULT_REGION
    print(f"Ingesting CGS historic metal-mining districts for: {region.name}")
    count = ingest_districts(region)
    print(f"✓ Loaded {count} mining districts into PostGIS table 'mining_districts'.")


def _run_potential() -> None:
    region = DEFAULT_REGION
    print(f"Ingesting CGS mineral-resource potential for: {region.name}")
    count = ingest_potential(region)
    print(f"✓ Loaded {count} mineral-potential polygons into PostGIS table 'mineral_potential'.")


def _run_aml() -> None:
    region = DEFAULT_REGION
    print(f"Ingesting CGS abandoned-mine-land hazards for: {region.name}")
    count = ingest_aml(region)
    print(f"✓ Loaded {count} AML hazard points into PostGIS table 'aml_hazards'.")


def _run_watershed() -> None:
    region = DEFAULT_REGION
    print(f"Ingesting USGS WBD HUC12 subwatersheds for: {region.name}")
    count = ingest_watersheds(region)
    print(f"✓ Loaded {count} subwatersheds into PostGIS table 'watersheds'.")


def _run_basemap() -> None:
    region = DEFAULT_REGION
    print(f"Building hillshade basemap (DEM → MBTiles) for: {region.name}")
    print("Downloads USGS 3DEP DEM cells and runs GDAL via Docker — this is slow.")
    out = build_basemap(region)
    print(f"✓ Built {out}. Start TileServer GL: docker compose up -d tileserver.")


def _run_all() -> None:
    """Run every ingestion step in dependency order (counties first — it's the clip mask)."""
    _run_counties()
    _run_mrds()
    _run_usmin()
    _run_geology()
    _run_ownership()
    _run_roads()
    _run_forest()
    _run_forests()
    _run_districts()
    _run_potential()
    _run_aml()
    _run_watershed()


def _run_refresh() -> None:
    """Re-pull every source fresh and re-ingest, then stamp the refresh date.

    Manual cadence (PRD §9.4 targets monthly for land status). Forces a fresh
    download of every source — including the large USFS national files — so the
    local data reflects the latest upstream. Writes data/processed/last_refresh.txt.
    """
    region = DEFAULT_REGION
    print(f"Refreshing ALL data (forcing fresh downloads) for: {region.name}")
    os.environ["PROSPECTOR_FORCE_DOWNLOAD"] = "1"
    try:
        _run_all()
    finally:
        os.environ.pop("PROSPECTOR_FORCE_DOWNLOAD", None)

    stamp = ensure_dir(PROCESSED_DIR) / "last_refresh.txt"
    when = datetime.now(timezone.utc).isoformat(timespec="seconds")
    stamp.write_text(f"{when}  {region.name}\n")
    print(f"✓ Refresh complete. Stamped {stamp} ({when}).")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(prog="prospector.ingest")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("counties", help="Download + load the county clip mask")
    sub.add_parser("mrds", help="Download + clip + load USGS MRDS mine points")
    sub.add_parser("usmin", help="Download + clip + load USGS USMIN topo mine features")
    sub.add_parser("geology", help="Download + clip + load USGS geologic unit polygons")
    sub.add_parser("ownership", help="Download + clip + load PAD-US land manager/owner polygons")
    sub.add_parser("roads", help="Download + load public roads + 4WD trails (TIGER)")
    sub.add_parser("forest", help="Download + load USFS forest roads + trails")
    sub.add_parser("forests", help="Download + load USFS Administrative Forest boundaries")
    sub.add_parser("districts", help="Download + load CGS historic metal-mining districts")
    sub.add_parser("potential", help="Download + load CGS mineral-resource potential")
    sub.add_parser("aml", help="Download + load CGS abandoned-mine-land hazards")
    sub.add_parser("watershed", help="Download + load USGS WBD HUC12 subwatersheds")
    sub.add_parser("all", help="Run every ingestion step in order")
    sub.add_parser("refresh", help="Force fresh re-download + re-ingest of every source")
    sub.add_parser("basemap", help="Build the hillshade basemap MBTiles (DEM via GDAL/Docker)")
    args = parser.parse_args()

    # Clipping needs the county mask, so counties must come first.
    if args.command == "counties":
        _run_counties()
    elif args.command == "mrds":
        _run_mrds()
    elif args.command == "usmin":
        _run_usmin()
    elif args.command == "geology":
        _run_geology()
    elif args.command == "ownership":
        _run_ownership()
    elif args.command == "roads":
        _run_roads()
    elif args.command == "forest":
        _run_forest()
    elif args.command == "forests":
        _run_forests()
    elif args.command == "districts":
        _run_districts()
    elif args.command == "potential":
        _run_potential()
    elif args.command == "aml":
        _run_aml()
    elif args.command == "watershed":
        _run_watershed()
    elif args.command == "all":
        _run_all()
    elif args.command == "refresh":
        _run_refresh()
    elif args.command == "basemap":
        _run_basemap()


if __name__ == "__main__":
    main()
