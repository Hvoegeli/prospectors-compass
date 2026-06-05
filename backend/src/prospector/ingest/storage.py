"""Local, git-ignored storage for downloaded data.

All downloads stay on the machine that ran them — the repo ships the code that
downloads, never the data (see .gitignore: ``backend/data/`` is ignored).
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

#: backend/ — this file is backend/src/prospector/ingest/storage.py
BACKEND_ROOT = Path(__file__).resolve().parents[3]

DATA_DIR = BACKEND_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"


def ensure_dir(path: Path) -> Path:
    """Create ``path`` (and parents) if needed; return it."""
    path.mkdir(parents=True, exist_ok=True)
    return path


def download_file(
    url: str, dest: Path, *, force: bool = False, timeout: float = 180, retries: int = 4
) -> Path:
    """Stream ``url`` to ``dest``, atomically, retrying transient failures. Returns ``dest``.

    Cached: skips the download if ``dest`` already exists unless ``force=True``.
    Setting ``PROSPECTOR_FORCE_DOWNLOAD=1`` forces a fresh download globally — the
    refresh command uses this to re-pull every source without re-plumbing each
    ingester (see ``prospector.ingest refresh``).
    Streams to a ``.part`` file and renames on success, so an interrupted
    download can never leave a truncated file at ``dest`` that later runs reuse.
    Transient failures (dropped connections, truncated bodies, 5xx) are retried
    with backoff — large public files (e.g. Census TIGER, USGS 3DEP) occasionally
    close the connection mid-stream; a 4xx (a real request error) is not retried.
    """
    force = force or os.getenv("PROSPECTOR_FORCE_DOWNLOAD") == "1"
    if dest.exists() and not force:
        log.info("Already cached: %s", dest)
        return dest

    ensure_dir(dest.parent)
    part = dest.with_name(dest.name + ".part")
    for attempt in range(retries):
        try:
            log.info("Downloading %s", url)
            with httpx.stream("GET", url, follow_redirects=True, timeout=timeout) as r:
                r.raise_for_status()
                with open(part, "wb") as f:
                    for chunk in r.iter_bytes(chunk_size=1 << 16):
                        f.write(chunk)
            os.replace(part, dest)
            log.info("Saved %s (%d bytes)", dest, dest.stat().st_size)
            return dest
        except (httpx.TransportError, httpx.HTTPStatusError) as exc:
            part.unlink(missing_ok=True)  # never leave a truncated file behind
            transient = isinstance(exc, httpx.TransportError) or (
                isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code >= 500
            )
            if not transient or attempt == retries - 1:
                raise
            wait = 2 * (attempt + 1)
            log.warning(
                "Download failed (%s); retry %d/%d in %ds", exc, attempt + 1, retries, wait
            )
            time.sleep(wait)
    raise RuntimeError("unreachable")  # pragma: no cover
