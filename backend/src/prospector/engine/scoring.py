"""Deterministic, explainable weighted-overlay prospectivity engine (v1).

Knowledge-driven Mineral Prospectivity Mapping: score a grid of cells over an
area by combining the ingested PostGIS layers into a 0-1 favorability:

    S = ( Σ wᵢ · fᵢ )  ×  gate_claims  ×  gate_ownership

where each ``fᵢ`` is a 0-1 fuzzy membership of one evidence factor and the
weights ``wᵢ`` sum to 1. The combination is a weighted SUM (not fuzzy-gamma /
weights-of-evidence) **so the score is additively decomposable** — each factor's
``wᵢ·fᵢ`` *is* the rationale shown to the user. Legality gates multiply (they can
only suppress, never reward). AML hazards are surfaced as a safety warning,
never folded into the score.

Two PROFILES select different factor sets + weights by target:
  - ``placer`` (gold in creeks) — water/terrain driven.
  - ``lode``   (hard rock / gems in host rock) — geology/structure/known-vein driven.

The engine never trains and uses no randomness → identical every run. Weights are
documented constants (see docs/ENGINE_WEIGHTS.md). The grid SQL computes only the
columns a profile actually needs, so the expensive watershed query runs for placer
only.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from prospector.ingest.terrain import SLOPE_TIF, sample_raster
from prospector.spatial._db import query_all

log = logging.getLogger(__name__)

WGS84 = 4326
_M_PER_DEG_LAT = 111_320.0

#: Allowed CGS mineral_potential rating columns (whitelist — interpolated into SQL).
_POTENTIAL_COLS = {"au_placer", "pegmatite", "corundum", "rare_earth", "fluorite"}

#: Gem targets whose host rock is fertile granite — they use the 'gem' profile and
#: get the radiometric thorium per-cell input (see GEM and _raw_inputs_sql).
GRANITE_FERTILITY_TARGETS = {"pegmatite", "corundum", "rare_earth"}


@dataclass(frozen=True)
class TargetSpec:
    label: str
    profile: str  # 'placer' | 'lode'
    potential_col: str | None  # a _POTENTIAL_COLS member, or None if no CGS layer
    commodity: str | None  # MRDS commodity token (context), or None


TARGETS: dict[str, TargetSpec] = {
    "au_placer": TargetSpec("Placer gold", "placer", "au_placer", "Gold"),
    "au_lode": TargetSpec("Lode gold", "lode", None, "Gold"),
    "silver": TargetSpec("Silver", "lode", None, "Silver"),
    "pegmatite": TargetSpec("Aquamarine & pegmatite gems", "gem", "pegmatite", "Beryllium"),
    "corundum": TargetSpec("Ruby & sapphire (corundum)", "gem", "corundum", "Gemstone"),
    "rare_earth": TargetSpec("Rare earths", "gem", "rare_earth", None),
    "fluorite": TargetSpec("Fluorite", "lode", "fluorite", "Fluorine-Fluorite"),
}


# ----------------------------------------------------------------------------------
# Fuzzy membership functions — raw measurement → 0-1 favorability.
# ----------------------------------------------------------------------------------
def ramp_down(d: float | None, dmax: float) -> float:
    """Linear decreasing membership: 1 at distance 0, → 0 at ``dmax`` meters."""
    if d is None:
        return 0.0
    return max(0.0, min(1.0, 1.0 - d / dmax))


def reclass_rating(r: int | None) -> float:
    """CGS favorability rating (1/2/3) → fuzzy score (high jumps super-linearly)."""
    return {1: 0.3, 2: 0.6, 3: 1.0}.get(r or 0, 0.0)


def placer_slope(deg: float | None) -> float:
    """Non-monotonic "Goldilocks" placer-grade membership.

    Placers form where the gradient drops — gentle valley grades (~2-10°), not
    cliffs or dead-flat basin floors. Peaks at 1.0 over 2-10°, ramps to 0 at
    <0.5° and >25°.
    """
    if deg is None:
        return 0.0
    if deg < 0.5 or deg > 25.0:
        return 0.0
    if 2.0 <= deg <= 10.0:
        return 1.0
    if deg < 2.0:
        return (deg - 0.5) / 1.5  # 0.5°→0, 2°→1
    return max(0.0, 1.0 - (deg - 10.0) / 15.0)  # 10°→1, 25°→0


def fuzzy_or(*vals: float) -> float:
    """Fuzzy algebraic sum 1 - ∏(1-vᵢ): correlated evidence saturates toward 1
    instead of summing past it (anti-double-count for the known-mineralization
    super-factor)."""
    prod = 1.0
    for v in vals:
        prod *= 1.0 - max(0.0, min(1.0, v))
    return 1.0 - prod


def host_lith_score(lith: str | None, potential_col: str | None) -> float:
    """Coarse host-lithology favorability (SGMC generalized_lith, 1:500k).

    Pegmatite/corundum gems favor intrusive/metamorphic hosts; generic lode favors
    igneous/metamorphic vein hosts over sediments. Rough v1 proxy — a future
    refinement once finer geology is available.
    """
    if not lith:
        return 0.0
    low = lith.lower()
    if potential_col in ("pegmatite", "corundum"):
        if "intrusive" in low:
            return 1.0
        if "metamorphic" in low:
            return 0.7
        return 0.2
    if "igneous" in low or "metamorphic" in low:
        return 0.7
    return 0.3


def radiometric_fertility(th_ppm: float | None) -> float:
    """Equivalent-thorium (ppm) → 0-1 'fertile granite' membership.

    Fractionated, gem-pegmatite-fertile granites are thorium-enriched. Ramps from
    0 at 8 ppm (≈ regional background median) to 1 at 12 ppm (≈ 90th percentile);
    thresholds from the Park County NURE proof-of-concept (2026-06-24), where known
    gem/pegmatite sites sat at the ~80th percentile of eTh vs county background.
    """
    if th_ppm is None:
        return 0.0
    return max(0.0, min(1.0, (th_ppm - 8.0) / 4.0))


# Land-ownership access gate by manager (mirrors the map's access grouping).
_OWNER_OPEN = {"Bureau of Land Management": 1.0, "Forest Service": 1.0}
_OWNER_STATE, _OWNER_PRIVATE, _OWNER_FED, _OWNER_UNKNOWN = 0.5, 0.2, 0.6, 0.5


def ownership_gate(manager: str | None) -> tuple[float, str]:
    """(gate 0-1, human label) for a land-ownership manager name."""
    if manager is None:
        return _OWNER_UNKNOWN, "Unknown ownership"
    if manager in _OWNER_OPEN:
        return _OWNER_OPEN[manager], f"{manager} (open to entry)"
    low = manager.lower()
    if "state" in low:
        return _OWNER_STATE, manager
    if "private" in low or "non-governmental" in low:
        return _OWNER_PRIVATE, f"{manager} (needs permission)"
    if any(k in low for k in ("fish and wildlife", "park", "reclamation", "energy", "corps")):
        return _OWNER_FED, manager
    return _OWNER_UNKNOWN, manager


# ----------------------------------------------------------------------------------
# Profiles — factor set + weights per profile. Weights sum to 1.0 (renormalized
# per target if a factor is structurally absent). Starting AHP-style expert
# weights; see docs/ENGINE_WEIGHTS.md.
# ----------------------------------------------------------------------------------
@dataclass(frozen=True)
class Factor:
    name: str
    label: str
    weight: float


@dataclass(frozen=True)
class Profile:
    factors: list[Factor] = field(default_factory=list)


PLACER = Profile([
    Factor("near_drainage", "Near a perennial creek/river", 0.25),
    Factor("valley_grade", "Gentle valley grade (placer slope)", 0.20),
    Factor("known_mineralization", "Known mineralization nearby", 0.35),
    Factor("source_in_basin", "Known gold source upstream in the basin", 0.20),
])

LODE = Profile([
    Factor("near_lode_mine", "Near a known lode mine/prospect", 0.28),
    Factor("near_fault", "Near a mapped fault (structure)", 0.22),
    Factor("in_district", "Inside/near a mining district", 0.22),
    Factor("cgs_potential", "CGS favorability rating", 0.16),
    Factor("host_lith", "Favorable host rock", 0.12),
])

# Gem/pegmatite targets (pegmatite, corundum, rare earth) form IN their fertile
# host granite, not along generic mining structure — so this profile LEADS with
# rock-favorability (measured thorium fertility + CGS rating + host lithology =
# 0.80) and de-emphasizes generic mine/fault/district proximity (0.20). The 80/20
# split was TUNED against the 76 known Park County gem/pegmatite sites: it keeps
# them at the ~97th percentile vs background while making ~71% of that score
# rock-driven, so it generalizes to UNMINED fertile ground rather than overfitting
# to known mines. Without a rock-led profile, any historic mining district (e.g.
# Breckenridge) scored high for gems regardless of suitability. See
# docs/ENGINE_WEIGHTS.md.
GEM = Profile([
    Factor("granite_fertility", "Fertile granite (radiometric thorium)", 0.37),
    Factor("cgs_potential", "CGS favorability rating", 0.26),
    Factor("host_lith", "Favorable host rock (intrusive/metamorphic)", 0.17),
    Factor("near_lode_mine", "Near a known mineral occurrence", 0.11),
    Factor("near_fault", "Near a mapped fault (structure)", 0.06),
    Factor("in_district", "Inside/near a mining district", 0.03),
])

PROFILES = {"placer": PLACER, "lode": LODE, "gem": GEM}


# ----------------------------------------------------------------------------------
# Grid raw-inputs SQL — profile-aware (only the columns a profile needs).
# ----------------------------------------------------------------------------------
#: Per-cell scalar-subquery SQL for each raw input (keyed by column name).
#: The WHERE uses a PLANAR ``ST_DWithin(geom, pt, degrees)`` so the geometry GiST
#: index is used (a ``geography()`` cast forces a full table scan — the original
#: perf bug). The degree radius slightly over-captures (≈ meters/80000, safe at CO
#: latitudes); the exact metric distance is the ``ST_Distance(geography(...))`` in
#: the SELECT, and the membership ramps do the real cutoff. Radii: 0.0625≈5km,
#: 0.0375≈3km, 0.0125≈1km.
_COL_SQL: dict[str, str] = {
    "d_placer_mine": (
        "(SELECT min(ST_Distance(geography(m.geom), geography(c.pt))) FROM mrds_sites m "
        "WHERE m.dep_type ILIKE :placer_pat AND ST_DWithin(m.geom, c.pt, 0.0625))"
    ),
    "d_lode_mine": (
        "(SELECT min(ST_Distance(geography(m.geom), geography(c.pt))) FROM mrds_sites m "
        "WHERE (m.dep_type IS NULL OR m.dep_type NOT ILIKE :placer_pat) "
        "AND ST_DWithin(m.geom, c.pt, 0.0625))"
    ),
    "d_stream": (
        "(SELECT min(ST_Distance(geography(s.geom), geography(c.pt))) FROM streams s "
        "WHERE ST_DWithin(s.geom, c.pt, 0.0125))"
    ),
    "d_fault": (
        "(SELECT min(ST_Distance(geography(f.geom), geography(c.pt))) FROM faults f "
        "WHERE ST_DWithin(f.geom, c.pt, 0.0375))"
    ),
    "in_district": "EXISTS (SELECT 1 FROM mining_districts d WHERE ST_Contains(d.geom, c.pt))",
    "d_district": (
        "(SELECT min(ST_Distance(geography(d.geom), geography(c.pt))) FROM mining_districts d "
        "WHERE ST_DWithin(d.geom, c.pt, 0.0375))"
    ),
    "lith": "(SELECT gu.generalized_lith FROM geologic_units gu WHERE ST_Contains(gu.geom, c.pt) LIMIT 1)",
    "source_in_basin": "EXISTS (SELECT 1 FROM source_basins sb WHERE ST_Contains(sb.geom, c.pt))",
}

#: Raw columns each profile's factors need (gates always add in_claim/owner;
#: placer adds slope, sampled in Python).
_PROFILE_COLS: dict[str, list[str]] = {
    "placer": ["d_stream", "d_placer_mine", "in_district", "d_district", "source_in_basin"],
    "lode": ["d_lode_mine", "d_fault", "in_district", "d_district", "lith"],
    # Gem uses the same raw inputs as lode; the radiometric thorium column is added
    # by _raw_inputs_sql for GRANITE_FERTILITY_TARGETS (the gem targets).
    "gem": ["d_lode_mine", "d_fault", "in_district", "d_district", "lith"],
}


def _raw_inputs_sql(profile: str, potential_col: str | None) -> str:
    cols = _PROFILE_COLS[profile]
    parts = [f"{_COL_SQL[c]} AS {c}" for c in cols]
    parts.append(
        (
            f"(SELECT max(p.{potential_col}) FROM mineral_potential p WHERE ST_Contains(p.geom, c.pt))"
            if potential_col
            else "NULL"
        )
        + " AS rating"
    )
    if potential_col in GRANITE_FERTILITY_TARGETS:
        # Nearest radiometric grid point's equivalent thorium (the KNN <-> operator
        # uses the GiST index; the 0.02° ≈ 1.6 km cap comfortably spans the ~1 km grid).
        parts.append(
            "(SELECT r.eth_ppm FROM radiometric r WHERE ST_DWithin(r.geom, c.pt, 0.02) "
            "ORDER BY r.geom <-> c.pt LIMIT 1) AS radiometric_th"
        )
    parts.append("EXISTS (SELECT 1 FROM mining_claims mc WHERE ST_Contains(mc.geom, c.pt)) AS in_claim")
    parts.append(
        "(SELECT lo.manager_name FROM land_ownership lo WHERE ST_Contains(lo.geom, c.pt) LIMIT 1) AS owner"
    )
    # Precompute source basins once (placer only) — the per-cell nested watershed
    # query was the performance killer.
    source_cte = ""
    if "source_in_basin" in cols:
        source_cte = (
            "source_basins AS ("
            " SELECT w.geom FROM watersheds w"
            " WHERE EXISTS (SELECT 1 FROM mrds_sites m WHERE m.dep_type ILIKE :placer_pat"
            "               AND ST_Intersects(m.geom, w.geom))"
            "    OR EXISTS (SELECT 1 FROM mining_districts d WHERE ST_Intersects(d.geom, w.geom))"
            "), "
        )
    select_cols = ",\n            ".join(parts)
    return f"""
        WITH {source_cte}g AS (
            SELECT (ST_SquareGrid(:cell, ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326))).geom AS cell
        ),
        c AS (
            SELECT cell, ST_Centroid(cell) AS pt FROM g
            WHERE EXISTS (SELECT 1 FROM counties co WHERE ST_Intersects(co.geom, ST_Centroid(cell)))
            LIMIT :max_cells
        )
        SELECT ST_X(c.pt) AS lon, ST_Y(c.pt) AS lat, ST_AsGeoJSON(c.cell) AS cell_geojson,
            {select_cols}
        FROM c
    """  # noqa: S608 — potential_col is whitelisted; all values are bound params.


def _factor_value(name: str, raw: dict, slope: float | None, potential_col: str | None) -> tuple[float, str]:
    """(membership 0-1, human 'raw' description) for one factor on one cell."""
    if name == "near_drainage":
        d = raw["d_stream"]
        return ramp_down(d, 300.0), f"{round(d)} m to a perennial stream" if d is not None else "no perennial stream within 1 km"
    if name == "valley_grade":
        return placer_slope(slope), f"slope {round(slope, 1)}°" if slope is not None else "slope unknown"
    if name == "known_mineralization":
        f_mine = ramp_down(raw["d_placer_mine"], 1000.0)
        f_dist = 1.0 if raw["in_district"] else ramp_down(raw["d_district"], 2000.0)
        f_pot = reclass_rating(raw["rating"])
        parts = []
        if raw["d_placer_mine"] is not None:
            parts.append(f"{round(raw['d_placer_mine'])} m to a placer mine")
        if raw["in_district"]:
            parts.append("inside a district")
        if raw["rating"]:
            parts.append(f"CGS rating {raw['rating']}")
        return fuzzy_or(f_mine, f_dist, f_pot), ", ".join(parts) or "no nearby known mineralization"
    if name == "source_in_basin":
        ok = raw["source_in_basin"]
        return (1.0 if ok else 0.0), "a known placer/district lies in this drainage basin" if ok else "no known source in this basin"
    if name == "near_lode_mine":
        d = raw["d_lode_mine"]
        return ramp_down(d, 1000.0), f"{round(d)} m to a lode mine/prospect" if d is not None else "no lode mine within 5 km"
    if name == "near_fault":
        d = raw["d_fault"]
        return ramp_down(d, 1000.0), f"{round(d)} m to a mapped fault" if d is not None else "no fault within 3 km"
    if name == "in_district":
        if raw["in_district"]:
            return 1.0, "inside a mining district"
        d = raw["d_district"]
        return ramp_down(d, 2000.0), f"{round(d)} m to a district" if d is not None else "no district within 3 km"
    if name == "cgs_potential":
        return reclass_rating(raw["rating"]), f"CGS rating {raw['rating']}" if raw["rating"] else "not CGS-rated here"
    if name == "host_lith":
        return host_lith_score(raw["lith"], potential_col), raw["lith"] or "lithology unknown"
    if name == "granite_fertility":
        th = raw.get("radiometric_th")
        return (
            radiometric_fertility(th),
            f"{th:.1f} ppm eq-thorium (radiometric)" if th is not None else "no radiometric coverage here",
        )
    return 0.0, ""


def _band(score: float) -> str:
    return "high" if score >= 0.66 else "moderate" if score >= 0.33 else "low"


def _effective_factors(spec: TargetSpec) -> list[Factor]:
    """Profile factors for this target, renormalized to sum to 1.0.

    The CGS rating factor is dropped for targets with no potential column (e.g.
    lode gold / silver); the remaining weights renormalize so a target is never
    penalized for a layer that doesn't exist for it. (The gem profile carries the
    radiometric ``granite_fertility`` factor natively — see ``GEM``.)
    """
    factors = [
        f
        for f in PROFILES[spec.profile].factors
        if not (f.name == "cgs_potential" and spec.potential_col is None)
    ]
    total = sum(f.weight for f in factors) or 1.0
    return [Factor(f.name, f.label, f.weight / total) for f in factors]


def score_area(
    target: str,
    bbox: tuple[float, float, float, float],
    *,
    cell_size_m: float = 250.0,
    max_cells: int = 3000,
    min_score: float = 0.15,
) -> dict:
    """Score a grid of cells over ``bbox`` for ``target``; return scored cells + rationale.

    Returns ``{target, profile, cell_size_m, count, cells: [...]}``. Each cell carries
    its 0-100 score, band, the sorted factor contributions (the rationale), and the
    legality gates. Cells below ``min_score`` are dropped (low ground isn't surfaced).
    """
    spec = TARGETS.get(target)
    if spec is None:
        raise ValueError(f"unknown target '{target}' (expected one of {sorted(TARGETS)})")
    if spec.potential_col and spec.potential_col not in _POTENTIAL_COLS:
        raise ValueError(f"bad potential column '{spec.potential_col}'")  # defensive

    minx, miny, maxx, maxy = bbox
    cell_deg = cell_size_m / _M_PER_DEG_LAT
    rows = query_all(
        _raw_inputs_sql(spec.profile, spec.potential_col),
        {
            "cell": cell_deg, "minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy,
            "max_cells": max_cells, "placer_pat": "%placer%",
        },
    )
    if not rows:
        return {"target": target, "profile": spec.profile, "cell_size_m": cell_size_m, "count": 0, "cells": []}

    # Slope is only used by the placer profile's valley_grade factor — sample it
    # (one batched GDAL call) only then.
    need_slope = spec.profile == "placer"
    slopes = sample_raster(SLOPE_TIF, [(r["lon"], r["lat"]) for r in rows]) if need_slope else [None] * len(rows)

    factors = _effective_factors(spec)
    cells = []
    for raw, slope in zip(rows, slopes, strict=True):
        breakdown = []
        total = 0.0
        for fac in factors:
            membership, desc = _factor_value(fac.name, raw, slope, spec.potential_col)
            contribution = membership * fac.weight
            total += contribution
            breakdown.append({
                "name": fac.name, "label": fac.label, "raw": desc,
                "membership": round(membership, 3), "weight": round(fac.weight, 3),
                "contribution": round(contribution, 3),
            })

        gate_owner, owner_label = ownership_gate(raw["owner"])
        gate_claim = 0.0 if raw["in_claim"] else 1.0
        score = total * gate_owner * gate_claim
        if score < min_score:
            continue

        breakdown.sort(key=lambda f: f["contribution"], reverse=True)
        cells.append({
            "lon": round(raw["lon"], 6), "lat": round(raw["lat"], 6),
            "geometry": raw["cell_geojson"],
            "score": round(score * 100, 1),
            "band": _band(score),
            "factors": breakdown,
            "gates": [
                {"name": "active_claims", "gate": gate_claim,
                 "raw": "inside an active mining claim" if raw["in_claim"] else "no active claim"},
                {"name": "land_ownership", "gate": round(gate_owner, 2), "raw": owner_label},
            ],
        })

    cells.sort(key=lambda c: c["score"], reverse=True)
    log.info("Scored %d cells (target=%s, profile=%s)", len(cells), target, spec.profile)
    return {
        "target": target,
        "profile": spec.profile,
        "cell_size_m": cell_size_m,
        "count": len(cells),
        "cells": cells,
    }
