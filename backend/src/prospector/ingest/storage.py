"""Local, git-ignored storage for downloaded data.

All downloads stay on the machine that ran them — the repo ships the code that
downloads, never the data (see .gitignore: ``backend/data/`` is ignored).
"""

from __future__ import annotations

from pathlib import Path

#: backend/ — this file is backend/src/prospector/ingest/storage.py
BACKEND_ROOT = Path(__file__).resolve().parents[3]

DATA_DIR = BACKEND_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"


def ensure_dir(path: Path) -> Path:
    """Create ``path`` (and parents) if needed; return it."""
    path.mkdir(parents=True, exist_ok=True)
    return path
