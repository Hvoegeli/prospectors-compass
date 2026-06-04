"""Shared helper: page through an ArcGIS REST query, bbox-filtered.

Used by ingesters that pull from ArcGIS MapServer/FeatureServer ``/query``
endpoints (CGS mineral potential, USGS WBD watersheds). A stable
``orderByFields`` is REQUIRED — without it ``resultOffset`` paging can reorder
rows between pages, duplicating some and skipping others (see ERROR_FIX_LOG).
"""

from __future__ import annotations

import logging
import time

import httpx

log = logging.getLogger(__name__)


def _post_page(query_url: str, data: dict, *, timeout: float, retries: int) -> dict:
    """POST one query page, retrying transient failures (5xx / timeouts) with backoff.

    Some public ArcGIS services (e.g. the TNM WBD MapServer) intermittently return
    504s under load. 4xx (a real request error) is not retried.
    """
    for attempt in range(retries):
        try:
            resp = httpx.post(query_url, data=data, timeout=timeout)
            resp.raise_for_status()
            return resp.json()
        except (httpx.TransportError, httpx.HTTPStatusError) as exc:
            transient = isinstance(exc, httpx.TransportError) or (
                isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code >= 500
            )
            if not transient or attempt == retries - 1:
                raise
            wait = 2 * (attempt + 1)
            log.warning("ArcGIS query failed (%s); retry %d/%d in %ds", exc, attempt + 1, retries, wait)
            time.sleep(wait)
    raise RuntimeError("unreachable")  # pragma: no cover


def fetch_features(
    query_url: str,
    bbox: tuple[float, float, float, float],
    *,
    out_fields: str,
    order_by: str,
    where: str = "1=1",
    page: int = 1000,
    sr: int = 4326,
    timeout: float = 120,
    retries: int = 4,
) -> list[dict]:
    """Page through an ArcGIS ``/query`` endpoint, returning GeoJSON features.

    Filters to ``bbox`` (an envelope in ``sr``), requests ``out_fields``, and
    orders by ``order_by`` (must be unique/stable) so offset paging is reliable.
    Smaller ``page`` sizes keep each request light for slow/flaky services.
    """
    minx, miny, maxx, maxy = bbox
    envelope = f"{minx},{miny},{maxx},{maxy}"
    features: list[dict] = []
    offset = 0
    while True:
        payload = _post_page(
            query_url,
            {
                "geometry": envelope,
                "geometryType": "esriGeometryEnvelope",
                "inSR": str(sr),
                "spatialRel": "esriSpatialRelIntersects",
                "where": where,
                "outFields": out_fields,
                "outSR": str(sr),
                "orderByFields": order_by,
                "resultOffset": str(offset),
                "resultRecordCount": str(page),
                "f": "geojson",
            },
            timeout=timeout,
            retries=retries,
        )
        batch = payload.get("features", [])
        features.extend(batch)
        log.info("ArcGIS query: fetched %d (offset %d)", len(features), offset)
        if len(batch) < page:
            break
        offset += page
    return features
