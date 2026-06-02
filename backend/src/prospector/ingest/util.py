"""Small shared helpers for ingestion."""

from __future__ import annotations

import pandas as pd


def na_to_none(value: object) -> str | None:
    """Pandas NaN / None -> None; everything else -> str (DB stores text or NULL)."""
    return None if value is None or pd.isna(value) else str(value)
