"""Point land-status lookup: "who manages the ground under this spot?"

Answers the desktop map's tap-to-identify popup. Given a lon/lat, it finds the
PAD-US ownership polygon(s) under the point (``spatial.proximity.point_in``) and
returns the manager / access / as-of-date already stored on each parcel, plus a
public/private read using the same grouping the recommendation engine uses
(``engine.scoring.ownership_gate``) so the two never disagree.

THE DISCLAIMER IS ATTACHED HERE, server-side, on every response. Per CLAUDE.md a
land-status answer must always carry the disclaimer and never make a go/no-go
call — putting it at the single endpoint that produces land status makes it
structurally impossible to get a land answer without it (the offline, rule-based
analogue of the old "agent layer" enforcement). PAD-US maps public land
authoritatively but carries no private-owner names; a point in no polygon is
reported honestly as "private or unmapped — not public land."
"""

from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import BaseModel

from prospector.engine.scoring import ownership_gate
from prospector.spatial.proximity import point_in

router = APIRouter(prefix="/land-status", tags=["land-status"])

#: The canonical land-status disclaimer. Attached to every response; do not
#: remove or soften it (CLAUDE.md "Land-status responses always carry the
#: disclaimer").
LAND_STATUS_DISCLAIMER = (
    "Informational only — not a legal determination of ownership, access, or the "
    "right to prospect or collect. Boundaries are approximate and may be out of "
    "date. Always verify on the ground and get landowner or agency permission "
    "before entering or digging."
)

#: Substrings (decoded names or raw PAD-US codes) that mark a parcel as private.
_PRIVATE_HINTS = ("private", "non-governmental", "pvt", "ngo")
#: ...and as public (government-managed) land.
_PUBLIC_HINTS = (
    "federal", "state", "local", "tribal", "fed", "stat", "loc", "trib",
    "desg", "government", "joint",
)


def _is_public(parcel: dict) -> bool | None:
    """True/False if the parcel is clearly public/private, else None (unknown)."""
    blob = " ".join(
        str(parcel.get(k))
        for k in ("manager_type", "owner_type", "manager_name")
        if parcel.get(k)
    ).lower()
    if not blob:
        return None
    if any(h in blob for h in _PRIVATE_HINTS):
        return False
    if any(h in blob for h in _PUBLIC_HINTS):
        return True
    # A named manager (e.g. "Bureau of Land Management") with no type still reads
    # as public; truly nothing → unknown.
    return True if parcel.get("manager_name") else None


class Parcel(BaseModel):
    manager_name: str | None = None
    manager_type: str | None = None
    owner_type: str | None = None
    unit_name: str | None = None
    public_access: str | None = None
    as_of_date: str | None = None
    #: Engine-consistent human label, e.g. "Bureau of Land Management (open to entry)".
    access_label: str
    #: True public, False private, None unknown.
    is_public: bool | None = None


class LandStatus(BaseModel):
    lon: float
    lat: float
    on_public_land: bool
    parcels: list[Parcel]
    summary: str
    disclaimer: str = LAND_STATUS_DISCLAIMER


@router.get("")
def land_status(
    lon: float = Query(..., ge=-180, le=180),
    lat: float = Query(..., ge=-90, le=90),
) -> LandStatus:
    """Land status at a point: manager(s), public/private, and the disclaimer."""
    rows = point_in("ownership", lon, lat)
    parcels: list[Parcel] = []
    for r in rows:
        manager = r.get("manager_name")
        parcels.append(
            Parcel(
                manager_name=manager,
                manager_type=r.get("manager_type"),
                owner_type=r.get("owner_type"),
                unit_name=r.get("unit_name"),
                public_access=r.get("public_access"),
                as_of_date=r.get("as_of_date"),
                access_label=ownership_gate(manager)[1],
                is_public=_is_public(r),
            )
        )

    on_public = any(p.is_public for p in parcels)

    if not parcels:
        summary = "Private or unmapped — not public land. Get permission before prospecting."
    elif on_public:
        p = next(pp for pp in parcels if pp.is_public)
        unit = f" · {p.unit_name}" if p.unit_name else ""
        summary = f"{p.access_label}{unit}"
    else:
        p = parcels[0]
        summary = f"{p.access_label} — get permission before prospecting."

    return LandStatus(
        lon=lon, lat=lat, on_public_land=on_public, parcels=parcels, summary=summary
    )
