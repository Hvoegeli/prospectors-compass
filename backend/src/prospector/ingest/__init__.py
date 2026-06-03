"""Data ingestion for Prospector's Compass (Group 2).

Every spatial source layer (USGS geology, MRDS, USMIN, BLM, USFS, CGS) is
clipped to the I-70 corridor focus area before it lands in PostGIS. The
canonical definition of that focus area lives in `focus_area.py` — import it
from there, never re-list the counties anywhere else.
"""
