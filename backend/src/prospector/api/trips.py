"""CRUD API for user-created prospecting trips (saved spots + field notes).

A trip is *user* data, not an ingested layer: a name + a JSONB list of waypoint
snapshots (see ``prospector.db.models.Trip``). Storage is the local Postgres, so
these calls are local and free — no cloud, no per-use cost. The contract is
deliberately simple for a single-user offline app: whole-trip save via PUT
(rename and/or replace the waypoint list) rather than granular per-waypoint
endpoints. This is the source the phone export will read from.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from prospector.db.base import SessionLocal
from prospector.db.models import Trip

router = APIRouter(prefix="/trips", tags=["trips"])


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ----------------------------------------------------------------------------------
# Schemas. A waypoint is a self-contained snapshot; `details` is free-form (the
# captured popup fields / score rationale), so it's an open dict.
# ----------------------------------------------------------------------------------
class Waypoint(BaseModel):
    id: str  # client-generated (uuid) — stable across the AirDrop round-trip
    lon: float
    lat: float
    title: str
    kind: str = "manual"  # 'engine' | 'mine' | 'manual'
    details: dict = Field(default_factory=dict)
    note: str = ""


class TripCreate(BaseModel):
    name: str


class TripUpdate(BaseModel):
    name: str | None = None
    waypoints: list[Waypoint] | None = None


class TripSummary(BaseModel):
    id: int
    name: str
    count: int
    created_at: datetime
    updated_at: datetime


class TripOut(BaseModel):
    id: int
    name: str
    waypoints: list[Waypoint]
    created_at: datetime
    updated_at: datetime


def _require(db: Session, trip_id: int) -> Trip:
    trip = db.get(Trip, trip_id)
    if trip is None:
        raise HTTPException(status_code=404, detail=f"trip {trip_id} not found")
    return trip


def _out(t: Trip) -> TripOut:
    return TripOut(
        id=t.id, name=t.name, waypoints=t.waypoints or [],
        created_at=t.created_at, updated_at=t.updated_at,
    )


@router.get("")
def list_trips(db: Session = Depends(get_db)) -> list[TripSummary]:
    """All trips, most-recently-updated first (for the Trips menu)."""
    trips = db.scalars(select(Trip).order_by(Trip.updated_at.desc())).all()
    return [
        TripSummary(
            id=t.id, name=t.name, count=len(t.waypoints or []),
            created_at=t.created_at, updated_at=t.updated_at,
        )
        for t in trips
    ]


@router.post("")
def create_trip(body: TripCreate, db: Session = Depends(get_db)) -> TripOut:
    trip = Trip(name=body.name.strip() or "Untitled trip", waypoints=[])
    db.add(trip)
    db.commit()
    db.refresh(trip)
    return _out(trip)


@router.get("/{trip_id}")
def get_trip(trip_id: int, db: Session = Depends(get_db)) -> TripOut:
    return _out(_require(db, trip_id))


@router.put("/{trip_id}")
def update_trip(trip_id: int, body: TripUpdate, db: Session = Depends(get_db)) -> TripOut:
    """Rename and/or replace the waypoint list (whole-trip save)."""
    trip = _require(db, trip_id)
    if body.name is not None and body.name.strip():
        trip.name = body.name.strip()
    if body.waypoints is not None:
        # Reassign (not in-place mutate) so SQLAlchemy detects the JSONB change.
        trip.waypoints = [w.model_dump() for w in body.waypoints]
    db.commit()
    db.refresh(trip)
    return _out(trip)


@router.delete("/{trip_id}")
def delete_trip(trip_id: int, db: Session = Depends(get_db)) -> dict[str, bool]:
    db.delete(_require(db, trip_id))
    db.commit()
    return {"ok": True}
