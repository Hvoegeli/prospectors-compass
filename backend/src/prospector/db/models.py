"""ORM models for ingested spatial data.

All geometries are stored in SRID 4326 (WGS84 lat/lon) — the project standard
(see docs/ERROR_FIX_LOG.md: mixing SRIDs silently returns empty results).
"""

from __future__ import annotations

from geoalchemy2 import Geometry
from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from prospector.db.base import Base

WGS84 = 4326


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
        Geometry(geometry_type="MULTIPOLYGON", srid=WGS84, spatial_index=True)
    )


class MrdsSite(Base):
    """A USGS MRDS mine / prospect / occurrence, clipped to a focus-area county.

    Source: USGS Mineral Resources Data System (https://mrdata.usgs.gov/mrds/).
    `county_geoid` is assigned by spatial join to our county polygons, not from
    MRDS's own (unreliable) county field.
    """

    __tablename__ = "mrds_sites"

    #: MRDS deposit id — globally unique within MRDS.
    dep_id: Mapped[str] = mapped_column(String, primary_key=True)
    site_name: Mapped[str | None] = mapped_column(String, nullable=True)
    url: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Focus-area county this site falls within (5-digit GEOID), via spatial join.
    county_geoid: Mapped[str] = mapped_column(String(5), nullable=False, index=True)
    #: Development status: Producer / Past Producer / Prospect / Occurrence / ...
    dev_stat: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Primary / secondary / tertiary commodities (MRDS commod1-3).
    commod1: Mapped[str | None] = mapped_column(String, nullable=True)
    commod2: Mapped[str | None] = mapped_column(String, nullable=True)
    commod3: Mapped[str | None] = mapped_column(String, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="POINT", srid=WGS84, spatial_index=True)
    )


class LandOwnership(Base):
    """A land parcel's surface manager/owner, clipped to the focus area.

    Source: USGS PAD-US 4.1 Fee layer (https://www.usgs.gov/...pad-us). Answers
    "who manages this ground?" (BLM / Forest Service / NPS / state / private) —
    the basis for land-status surfacing. Coverage layer, re-ingest scoped by
    `state_fips`.

    NOTE: this is informational only. Land-status ANSWERS must always carry the
    disclaimer and never make a go/no-go determination (enforced at the agent
    layer). `as_of_date` is the per-record source date (PRD §9.4 requirement).
    """

    __tablename__ = "land_ownership"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state_fips: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    #: Decoded manager name, e.g. "Bureau of Land Management", "Forest Service".
    manager_name: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    #: Decoded manager type, e.g. "Federal", "State", "Local", "Private".
    manager_type: Mapped[str | None] = mapped_column(String, nullable=True)
    owner_type: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Specific unit name (forest, WMA, park, …) where present.
    unit_name: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Public access category: Open / Restricted / Closed / Unknown.
    public_access: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Per-record source date (the mandatory "as-of" stamp for land status).
    as_of_date: Mapped[str | None] = mapped_column(String, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="MULTIPOLYGON", srid=WGS84, spatial_index=True)
    )


class UsminFeature(Base):
    """A USGS USMIN mine/prospect feature digitized from a topographic map.

    Source: USGS Prospect- and Mine-Related Features (USMIN), per-state
    shapefile from https://mrdata.usgs.gov/usmin/. Point features (adits,
    shafts, prospect pits, etc.). `county_geoid` is assigned by spatial join.
    No reliable natural key, so a surrogate id is used.
    """

    __tablename__ = "usmin_features"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    #: USMIN feature id (GDA_ID), kept for provenance; not guaranteed unique here.
    gda_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    county_geoid: Mapped[str] = mapped_column(String(5), nullable=False, index=True)
    #: Feature type: Adit / Shaft / Prospect / Mine / Quarry / ...
    ftr_type: Mapped[str | None] = mapped_column(String, nullable=True)
    ftr_name: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Source topo quad name + date (provenance).
    topo_name: Mapped[str | None] = mapped_column(String, nullable=True)
    topo_date: Mapped[str | None] = mapped_column(String, nullable=True)
    remarks: Mapped[str | None] = mapped_column(String, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="POINT", srid=WGS84, spatial_index=True)
    )


class GeologicUnit(Base):
    """A geologic map-unit polygon, clipped to the focus area.

    Source: USGS State Geologic Map Compilation (per-state shapefile from
    https://mrdata.usgs.gov/geology/state/). Polygons are enriched from the
    package's unit lookup (name, age, lithology) via `unit_link`.

    A unit spans many counties, so this is a coverage layer with no single
    county tag. Re-ingest is scoped by `state_fips` (geology is per-state).
    """

    __tablename__ = "geologic_units"

    #: Surrogate key — a unit_link repeats across many polygons, so it's not unique.
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state_fips: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    #: Join key to the unit lookup, e.g. "COCAam;0".
    unit_link: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    orig_label: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Generalized lithology, e.g. "Igneous, intrusive".
    generalized_lith: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Enriched from the unit lookup table.
    unit_name: Mapped[str | None] = mapped_column(String, nullable=True)
    unit_age: Mapped[str | None] = mapped_column(String, nullable=True)
    rocktype1: Mapped[str | None] = mapped_column(String, nullable=True)
    rocktype2: Mapped[str | None] = mapped_column(String, nullable=True)
    rocktype3: Mapped[str | None] = mapped_column(String, nullable=True)
    unit_desc: Mapped[str | None] = mapped_column(String, nullable=True)
    url: Mapped[str | None] = mapped_column(String, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="MULTIPOLYGON", srid=WGS84, spatial_index=True)
    )
