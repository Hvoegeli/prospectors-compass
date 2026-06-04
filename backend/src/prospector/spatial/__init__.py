"""Spatial query tools (PostGIS / raster) for the prospecting agents.

Framework-agnostic functions that answer spatial questions over the ingested
layers — distance-from-road, what's-nearby, which-watershed, slope/aspect. They
return plain dicts/lists so the Group 4 LangGraph subagents can wrap them as
tools without any tool-framework coupling here.

All inputs are WGS84 lon/lat; all distances are in meters (geometries are cast
to `geography` for metric accuracy).
"""
