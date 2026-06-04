"""Distance-from-road and accessibility scoring.

"How do I reach this spot, and how hard is it?" — a core prospecting question.
Uses the `roads` table (public TIGER + USFS forest roads/trails). Nearest-road
search orders by the true geodesic distance (`ST_Distance` over `geography`);
the roads table is small (focus area), so the exact scan is fast and accurate.
"""

from __future__ import annotations

from prospector.spatial._db import PT, query_first

# Accessibility bands by distance (m) to the nearest *drivable* road.
_BANDS: list[tuple[float, str]] = [
    (50, "roadside"),
    (500, "easy"),
    (2_000, "moderate"),
    (8_000, "hard"),
]


def nearest_road(lon: float, lat: float, *, drivable_only: bool = False) -> dict | None:
    """Nearest road/trail to the point.

    Returns ``{meters, name, road_class, kind, category}`` (meters rounded), or
    ``None`` if the roads table is empty. With ``drivable_only`` only ``category
    = 'road'`` segments are considered (excludes foot/4WD trails).
    """
    where = "WHERE category = 'road'" if drivable_only else ""
    # Order by the true geodesic (geography) distance — NOT the planar `<->`
    # operator, whose degree-based ordering can pick the wrong road when two are
    # at similar distances in different directions (lon° ≠ lat° in meters). The
    # roads table is small (focus area), so the scan+sort is exact and fast.
    sql = f"""
        SELECT name, road_class, kind, category,
               ST_Distance(geography(geom), geography({PT})) AS meters
        FROM roads
        {where}
        ORDER BY meters
        LIMIT 1
    """  # noqa: S608 — `where` is a fixed string, not user input
    row = query_first(sql, {"lon": lon, "lat": lat})
    if row is None:
        return None
    return {
        "meters": round(row["meters"], 1),
        "name": row["name"],
        "road_class": row["road_class"],
        "kind": row["kind"],
        "category": row["category"],
    }


def _band(meters: float | None) -> str:
    if meters is None:
        return "unknown"
    for limit, label in _BANDS:
        if meters <= limit:
            return label
    return "remote"


def accessibility(lon: float, lat: float) -> dict:
    """Accessibility summary for a point.

    Combines the nearest road of any kind with the nearest *drivable* road and
    bins the drivable distance into a qualitative rating (roadside / easy /
    moderate / hard / remote) — how far off the road network the spot is.
    """
    any_road = nearest_road(lon, lat)
    drivable = nearest_road(lon, lat, drivable_only=True)
    drivable_m = drivable["meters"] if drivable else None
    return {
        "nearest_road_m": any_road["meters"] if any_road else None,
        "nearest_drivable_road_m": drivable_m,
        "drivable_road_name": drivable["name"] if drivable else None,
        "rating": _band(drivable_m),
    }
