"""CLI for local data ingestion.

    uv run python -m prospector.ingest counties   # download + load the clip mask

Runs against the v1 default region (the I-70 corridor). Later, the county-picker
UI will pass a user-built region to these same functions.
"""

from __future__ import annotations

import argparse
import logging

from prospector.ingest.census import ingest_counties
from prospector.ingest.focus_area import DEFAULT_REGION


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(prog="prospector.ingest")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("counties", help="Download + load the county clip mask")
    args = parser.parse_args()

    if args.command == "counties":
        region = DEFAULT_REGION
        print(f"Ingesting counties for: {region.name}")
        print(f"  Counties ({len(region.counties)}): {', '.join(region.county_names())}")
        count = ingest_counties(region)
        print(f"✓ Loaded {count} counties into PostGIS table 'counties'.")


if __name__ == "__main__":
    main()
