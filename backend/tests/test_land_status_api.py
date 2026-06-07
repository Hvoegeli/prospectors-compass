"""Tests for the /land-status tap-to-identify endpoint.

The headline invariant: every successful response carries the disclaimer (it is
attached server-side and must never be optional — CLAUDE.md). DB-backed
assertions skip cleanly when Postgres is unreachable or PAD-US isn't ingested.
"""

import psycopg
import pytest
from fastapi.testclient import TestClient

from prospector.api.land_status import LAND_STATUS_DISCLAIMER
from prospector.config import settings
from prospector.main import app

client = TestClient(app)

# A point on Forest Service ground near Mt Antero (public); and a town center
# (Salida) that PAD-US does not map as public land.
_PUBLIC_PT = {"lon": -106.2454, "lat": 38.6745}
_PRIVATE_PT = {"lon": -105.9989, "lat": 38.5347}


def _db_up() -> bool:
    try:
        psycopg.connect(settings.database_url, connect_timeout=2).close()
        return True
    except psycopg.OperationalError:
        return False


def _ownership_ingested() -> bool:
    body = client.get("/layers/ownership", params={"limit": 1}).json()
    return bool(body.get("features"))


def test_missing_coords_422():
    # lon/lat are required query params.
    assert client.get("/land-status").status_code == 422


def test_out_of_range_coords_422():
    assert client.get("/land-status", params={"lon": 200, "lat": 0}).status_code == 422


def test_disclaimer_always_present():
    if not _db_up():
        pytest.skip("Postgres not reachable")
    # Even an ocean point with no parcel must still carry the disclaimer.
    resp = client.get("/land-status", params={"lon": -140.0, "lat": 40.0})
    assert resp.status_code == 200
    body = resp.json()
    assert body["disclaimer"] == LAND_STATUS_DISCLAIMER
    assert body["on_public_land"] is False
    assert body["parcels"] == []


def test_public_land_resolves_manager():
    if not _db_up():
        pytest.skip("Postgres not reachable")
    if not _ownership_ingested():
        pytest.skip("ownership (PAD-US) not ingested — run the ingest CLI")
    body = client.get("/land-status", params=_PUBLIC_PT).json()
    assert body["disclaimer"] == LAND_STATUS_DISCLAIMER
    assert body["on_public_land"] is True
    p = body["parcels"][0]
    assert p["manager_name"]  # e.g. "Forest Service"
    assert p["is_public"] is True
    assert p["access_label"]  # engine-consistent human label


def test_unmapped_point_reads_as_private():
    if not _db_up():
        pytest.skip("Postgres not reachable")
    if not _ownership_ingested():
        pytest.skip("ownership (PAD-US) not ingested — run the ingest CLI")
    body = client.get("/land-status", params=_PRIVATE_PT).json()
    assert body["disclaimer"] == LAND_STATUS_DISCLAIMER
    assert body["on_public_land"] is False
    assert "permission" in body["summary"].lower()
