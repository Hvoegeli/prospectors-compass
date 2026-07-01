"""CRUD API for user-created prospecting trips (saved spots + field notes).

A trip is *user* data, not an ingested layer: a name + a JSONB list of waypoint
snapshots (see ``prospector.db.models.Trip``). Storage is the local Postgres, so
these calls are local and free — no cloud, no per-use cost. The contract is
deliberately simple for a single-user offline app: whole-trip save via PUT
(rename and/or replace the waypoint list) rather than granular per-waypoint
endpoints. This is the source the phone export will read from.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from collections.abc import Iterator
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from starlette.background import BackgroundTask

from prospector.db.base import SessionLocal
from prospector.db.models import Trip
from prospector.export.bundle import build_trip_bundle
from prospector.ingest.storage import DATA_DIR, ensure_dir

# Field finds logged on the phone ride home in a `.pcfinds` zip (finds.json +
# photos/), the mirror of the `.pcbundle` the desktop sends out. Photos are stored
# locally (data/ is gitignored) and served read-only by the StaticFiles mount in
# `main.py` at the matching `/find-photos/<trip_id>/<find_id>.jpg` URL.
FINDS_BUNDLE_FORMAT = "prospectors-compass.finds-bundle"
FIND_PHOTOS_DIR = DATA_DIR / "find-photos"

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

    @field_validator("details", mode="before")
    @classmethod
    def _details_never_null(cls, v: object) -> object:
        # A stored waypoint can carry an explicit null `details` (e.g. a marker pin
        # saved with details=None). Coerce it to {} BEFORE the dict type-check so a
        # single null can't fail TripOut validation and 500 the whole trip GET. The
        # frontend's contract is that `details` is always an object.
        return {} if v is None else v


class TripCreate(BaseModel):
    name: str
    #: Engine target this trip is for (e.g. "au_placer") — what its exported
    #: heat map gets scored for. Captured from the desktop's current selection.
    target: str | None = None


class TripUpdate(BaseModel):
    name: str | None = None
    target: str | None = None
    waypoints: list[Waypoint] | None = None


class TripSummary(BaseModel):
    id: int
    name: str
    target: str | None = None
    count: int
    created_at: datetime
    updated_at: datetime


class TripOut(BaseModel):
    id: int
    name: str
    target: str | None = None
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
        id=t.id, name=t.name, target=t.target, waypoints=t.waypoints or [],
        created_at=t.created_at, updated_at=t.updated_at,
    )


@router.get("")
def list_trips(db: Session = Depends(get_db)) -> list[TripSummary]:
    """All trips, most-recently-updated first (for the Trips menu)."""
    trips = db.scalars(select(Trip).order_by(Trip.updated_at.desc())).all()
    return [
        TripSummary(
            id=t.id, name=t.name, target=t.target, count=len(t.waypoints or []),
            created_at=t.created_at, updated_at=t.updated_at,
        )
        for t in trips
    ]


@router.post("")
def create_trip(body: TripCreate, db: Session = Depends(get_db)) -> TripOut:
    trip = Trip(name=body.name.strip() or "Untitled trip", target=body.target, waypoints=[])
    db.add(trip)
    db.commit()
    db.refresh(trip)
    return _out(trip)


@router.get("/{trip_id}")
def get_trip(trip_id: int, db: Session = Depends(get_db)) -> TripOut:
    return _out(_require(db, trip_id))


@router.post("/import-finds")
async def import_finds(request: Request, db: Session = Depends(get_db)) -> TripOut:
    """Import a phone-exported ``.pcfinds`` bundle (raw zip request body) into its
    home trip. Finds become ``kind="find"`` waypoints appended next to the planned
    spots; photos are written under ``data/find-photos/<trip_id>/`` and referenced
    by their served URL. Idempotent: each find carries a stable id, so re-importing
    the same bundle skips finds already present rather than duplicating them. The
    home trip is matched by the id baked into the bundle, or created if it's gone."""
    raw = await request.body()
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="not a valid .pcfinds file") from exc
    try:
        manifest = json.loads(zf.read("finds.json"))
    except KeyError as exc:
        raise HTTPException(status_code=400, detail="bundle is missing finds.json") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="finds.json is not valid JSON") from exc
    if manifest.get("format") != FINDS_BUNDLE_FORMAT:
        raise HTTPException(status_code=400, detail="unrecognized finds bundle format")

    trip_info = manifest.get("trip") or {}
    trip_id = trip_info.get("id")
    finds = manifest.get("finds") or []

    # Match the home trip by id; if it's gone, recreate it so a find can't vanish.
    trip = db.get(Trip, trip_id) if isinstance(trip_id, int) else None
    if trip is None:
        name = (trip_info.get("name") or "").strip() or "Imported finds"
        trip = Trip(name=name, waypoints=[])
        db.add(trip)
        db.flush()  # assign trip.id before we use it for the photo path
    target_id = trip.id

    waypoints = list(trip.waypoints or [])
    seen_ids = {w.get("id") for w in waypoints}
    photo_dir = FIND_PHOTOS_DIR / str(target_id)
    for f in finds:
        fid = f.get("id")
        # Require an integer id (the phone stamps Date.now()): it becomes a path
        # segment for the photo file, so a non-int id (e.g. "../x") must never be
        # trusted, and it's the stable dedupe key. bool is an int subclass — exclude it.
        if not isinstance(fid, int) or isinstance(fid, bool):
            continue
        lon, lat = f.get("lon"), f.get("lat")
        if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
            continue  # a find with no GPS can't be placed on the map — skip it
        wp_id = f"find-{target_id}-{fid}"
        if wp_id in seen_ids:
            continue  # already imported — idempotent re-import

        photo_url = None
        photo_name = f.get("photo")
        if photo_name:
            try:
                data = zf.read(f"photos/{photo_name}")
            except KeyError:
                data = None  # referenced photo missing from the zip — keep the find
            if data is not None:
                ensure_dir(photo_dir)
                (photo_dir / f"{fid}.jpg").write_bytes(data)
                photo_url = f"/find-photos/{target_id}/{fid}.jpg"

        waypoints.append({
            "id": wp_id,
            "lon": float(lon),
            "lat": float(lat),
            "title": f"Find: {f.get('kind') or 'sample'}",
            "kind": "find",
            "details": {
                "find_kind": f.get("kind"),
                "created_at": f.get("created_at"),
                "photo": photo_url,
            },
            "note": f.get("note") or "",
        })
        seen_ids.add(wp_id)

    # Annotations (v2 bundles): notes the user added to pins, and pins they dropped.
    # Unlike finds (append-only), these are EDITS, so they upsert — re-importing
    # applies the latest. v1 bundles have no `annotations` key, so this is a no-op
    # for them (backward compatible).
    ann = manifest.get("annotations")
    ann = ann if isinstance(ann, dict) else {}
    ann_notes = ann.get("notes")
    ann_notes = ann_notes if isinstance(ann_notes, dict) else {}
    ann_pins = ann.get("pins")
    ann_pins = ann_pins if isinstance(ann_pins, list) else []
    wp_by_id = {w.get("id"): w for w in waypoints}

    # Dropped pins -> manual waypoints, each carrying its own note (keyed by pin id).
    for p in ann_pins:
        if not isinstance(p, dict):
            continue
        pid = p.get("id")
        if not isinstance(pid, int) or isinstance(pid, bool):
            continue
        lon, lat = p.get("lon"), p.get("lat")
        if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
            continue
        wp_id = f"drop-{target_id}-{pid}"
        raw_note = ann_notes.get(str(pid))
        note = raw_note if isinstance(raw_note, str) else ""
        title = p.get("title") if isinstance(p.get("title"), str) and p.get("title") else "Dropped pin"
        existing = wp_by_id.get(wp_id)
        if existing is not None:
            existing.update({"lon": float(lon), "lat": float(lat), "title": title, "note": note})
        else:
            wp = {"id": wp_id, "lon": float(lon), "lat": float(lat),
                  "title": title, "kind": "manual", "details": {}, "note": note}
            waypoints.append(wp)
            wp_by_id[wp_id] = wp

    # Notes on planned pins: the key is the bundle waypoint's own id, so set the note
    # on that waypoint. Dropped-pin note keys are numeric pin ids that match no
    # waypoint id here (those notes were applied above), so they're skipped.
    for wpid, text in ann_notes.items():
        w = wp_by_id.get(wpid)
        if w is not None:
            w["note"] = text if isinstance(text, str) else ""

    trip.waypoints = waypoints  # reassign (not in-place) so SQLAlchemy sees the change
    # Annotations upsert dicts in place; a shallow-copied list shares those dict refs
    # with SQLAlchemy's committed snapshot, so without an explicit flag the no-append
    # case (only edits) flushes nothing. Force the JSON column dirty.
    flag_modified(trip, "waypoints")
    db.commit()
    db.refresh(trip)
    return _out(trip)


@router.get("/{trip_id}/export-bundle")
def export_trip_bundle(
    trip_id: int,
    target: str | None = Query(
        None,
        description="engine target id to bake in; defaults to the trip's saved resource",
    ),
    buffer_mi: float = Query(3.0, ge=0.5, le=25, description="footprint pad around the waypoints"),
    db: Session = Depends(get_db),
) -> FileResponse:
    """Build + download a single-file offline ``.pcbundle`` for the iOS field app:
    the trip's waypoints, the engine's scored areas over the trip footprint, and a
    clipped terrain basemap. The temp file is deleted after the response is sent.

    The heat map is scored for the trip's own resource (``trip.target``) so it always
    matches the pins; an explicit ``target`` query param can still override it."""
    trip = _require(db, trip_id)
    resolved_target = target or trip.target
    if not resolved_target:
        raise HTTPException(
            status_code=400,
            detail="This trip has no resource set — choose what you're prospecting for before exporting.",
        )
    try:
        path = build_trip_bundle(trip.id, trip.name, trip.waypoints or [], resolved_target, buffer_mi)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", trip.name).strip("-") or f"trip-{trip.id}"
    return FileResponse(
        path,
        media_type="application/zip",
        filename=f"{slug}.pcbundle",
        background=BackgroundTask(path.unlink, missing_ok=True),
    )


@router.put("/{trip_id}")
def update_trip(trip_id: int, body: TripUpdate, db: Session = Depends(get_db)) -> TripOut:
    """Rename and/or replace the waypoint list (whole-trip save)."""
    trip = _require(db, trip_id)
    if body.name is not None and body.name.strip():
        trip.name = body.name.strip()
    if body.target is not None:
        trip.target = body.target or None  # "" clears it
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
