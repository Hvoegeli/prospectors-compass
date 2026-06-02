"""Tests for the GeoJSON layers API.

DB-backed assertions skip cleanly when Postgres is unreachable or the layer
hasn't been ingested.
"""

import psycopg
import pytest
from fastapi.testclient import TestClient

from prospector.config import settings
from prospector.main import app

client = TestClient(app)


def _db_up() -> bool:
    try:
        psycopg.connect(settings.database_url, connect_timeout=2).close()
        return True
    except psycopg.OperationalError:
        return False


def test_list_layers():
    resp = client.get("/layers")
    assert resp.status_code == 200
    names = resp.json()["layers"]
    assert {"counties", "mrds", "usmin", "geology", "ownership"} <= set(names)


def test_unknown_layer_404():
    assert client.get("/layers/nope").status_code == 404


def test_bad_bbox_400():
    if not _db_up():
        pytest.skip("Postgres not reachable")
    assert client.get("/layers/counties", params={"bbox": "1,2,3"}).status_code == 400


def test_counties_geojson():
    if not _db_up():
        pytest.skip("Postgres not reachable")
    resp = client.get("/layers/counties")
    assert resp.status_code == 200
    fc = resp.json()
    assert fc["type"] == "FeatureCollection"
    if not fc["features"]:
        pytest.skip("counties not ingested — run the ingest CLI")
    feat = fc["features"][0]
    assert feat["type"] == "Feature"
    assert feat["geometry"]["type"] in ("Polygon", "MultiPolygon")
    assert "geoid" in feat["properties"]
    # geom must not leak into properties.
    assert "geom" not in feat["properties"]


def test_mrds_facets():
    if not _db_up():
        pytest.skip("Postgres not reachable")
    resp = client.get("/layers/mrds/facets")
    assert resp.status_code == 200
    body = resp.json()
    assert "commodities" in body and "deposit_types" in body
    if not body["commodities"]:
        pytest.skip("mrds not ingested")
    # Commodities are tokenized — single values, not comma-joined combinations.
    assert all("," not in c for c in body["commodities"])
    assert "Gold" in body["commodities"]


def test_commodity_filter_reduces_features():
    if not _db_up():
        pytest.skip("Postgres not reachable")
    full = client.get("/layers/mrds").json()
    if len(full["features"]) < 2:
        pytest.skip("mrds not ingested")
    gold = client.get("/layers/mrds", params={"commodity": "Gold"}).json()
    assert 0 < len(gold["features"]) < len(full["features"])


def test_bbox_filter_reduces_features():
    if not _db_up():
        pytest.skip("Postgres not reachable")
    full = client.get("/layers/counties").json()
    if len(full["features"]) < 2:
        pytest.skip("counties not ingested")
    # A tiny bbox over Denver should return fewer counties than the full set.
    small = client.get(
        "/layers/counties", params={"bbox": "-105.0,39.7,-104.9,39.8"}
    ).json()
    assert len(small["features"]) < len(full["features"])
