"""ORM models for ingested spatial data.

All geometries are stored in SRID 4326 (WGS84 lat/lon) — the project standard
(see docs/ERROR_FIX_LOG.md: mixing SRIDs silently returns empty results).
"""

from __future__ import annotations

from geoalchemy2 import Geometry
from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from prospector.db.base import Base


class County(Base):
    """A US county boundary, downloaded from Census TIGER/Line.

    Stores whichever counties a user chose to download. The clip mask for any
    ingestion is the union of the selected counties' geometries.
    """

    __tablename__ = "counties"

    #: 5-digit state+county GEOID, e.g. "08031" (Denver, CO).
    geoid: Mapped[str] = mapped_column(String(5), primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    state_fips: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="MULTIPOLYGON", srid=4326, spatial_index=True)
    )
