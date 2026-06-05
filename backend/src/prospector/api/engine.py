"""Serve the recommendation engine's scored areas to the desktop map.

`GET /engine/targets` — the targets the engine can score (id + label + profile).
`GET /engine/score`   — score a grid over a bbox for a target, returning each
                        cell's 0-100 favorability + its factor-by-factor rationale
                        (see `prospector.engine.scoring`).

Scoring is viewport-scoped (the frontend passes its current bbox) and on-demand —
it grids the area, queries the PostGIS layers, and combines them deterministically.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from prospector.engine.scoring import TARGETS, score_area

router = APIRouter(prefix="/engine", tags=["engine"])


@router.get("/targets")
def list_targets() -> dict[str, list[dict]]:
    """Targets the engine can score, with their profile (placer / lode)."""
    return {
        "targets": [
            {"id": tid, "label": spec.label, "profile": spec.profile}
            for tid, spec in TARGETS.items()
        ]
    }


@router.get("/score")
def score(
    target: str = Query(..., description="a target id from /engine/targets"),
    bbox: str = Query(..., description="minLon,minLat,maxLon,maxLat (WGS84)"),
    cell_size_m: float = Query(250.0, ge=100, le=1000),
    max_cells: int = Query(3000, ge=1, le=6000),
    min_score: float = Query(0.15, ge=0, le=1),
) -> dict:
    """Score a grid of cells over ``bbox`` for ``target`` (factor-by-factor rationale)."""
    try:
        minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="bbox must be 'minLon,minLat,maxLon,maxLat'") from exc
    try:
        return score_area(
            target,
            (minx, miny, maxx, maxy),
            cell_size_m=cell_size_m,
            max_cells=max_cells,
            min_score=min_score,
        )
    except ValueError as exc:  # unknown target
        raise HTTPException(status_code=404, detail=str(exc)) from exc
