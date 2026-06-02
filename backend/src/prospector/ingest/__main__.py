"""CLI for local data ingestion.

    uv run python -m prospector.ingest counties   # download + load the clip mask
    uv run python -m prospector.ingest mrds        # USGS mine/prospect points
    uv run python -m prospector.ingest geology     # USGS geologic unit polygons
    uv run python -m prospector.ingest all         # clip mask, then every layer

Runs against the v1 default region (the I-70 corridor). Later, the county-picker
UI will pass a user-built region to these same functions.
"""

from __future__ import annotations

import argparse
import logging

from prospector.ingest.census import ingest_counties
from prospector.ingest.focus_area import DEFAULT_REGION
from prospector.ingest.geology import ingest_geology
from prospector.ingest.mrds import ingest_mrds


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


def _run_geology() -> None:
    region = DEFAULT_REGION
    print(f"Ingesting geologic units for: {region.name}")
    count = ingest_geology(region)
    print(f"✓ Loaded {count} geologic units into PostGIS table 'geologic_units'.")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(prog="prospector.ingest")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("counties", help="Download + load the county clip mask")
    sub.add_parser("mrds", help="Download + clip + load USGS MRDS mine points")
    sub.add_parser("geology", help="Download + clip + load USGS geologic unit polygons")
    sub.add_parser("all", help="Run every ingestion step in order")
    args = parser.parse_args()

    # Clipping needs the county mask, so counties must come first.
    if args.command == "counties":
        _run_counties()
    elif args.command == "mrds":
        _run_mrds()
    elif args.command == "geology":
        _run_geology()
    elif args.command == "all":
        _run_counties()
        _run_mrds()
        _run_geology()


if __name__ == "__main__":
    main()
