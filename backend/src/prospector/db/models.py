"""ORM models for ingested spatial data.

All geometries are stored in SRID 4326 (WGS84 lat/lon) — the project standard
(see docs/ERROR_FIX_LOG.md: mixing SRIDs silently returns empty results).
"""

from __future__ import annotations

from datetime import datetime

from geoalchemy2 import Geometry
from sqlalchemy import DateTime, Float, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
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
    #: Deposit type (MRDS dep_type), e.g. "Placer", "Vein", ... — for filtering.
    dep_type: Mapped[str | None] = mapped_column(String, nullable=True)
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


class RoadSegment(Base):
    """A road line — public (Census TIGER) or Forest Service (USFS), for access.

    `kind` distinguishes 'public' vs 'forest'. Re-ingest is scoped by
    (state_fips, kind) so re-running one source doesn't wipe the other.
    Supports PRD MVP5 distance-from-road / accessibility scoring.
    """

    __tablename__ = "roads"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state_fips: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    #: 'road' (drivable) or 'trail' (4WD/foot) — drives the two map toggles.
    category: Mapped[str] = mapped_column(String, nullable=False, index=True)
    #: 'public' (TIGER) or 'forest' (USFS).
    kind: Mapped[str] = mapped_column(String, nullable=False, index=True)
    name: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Class/drivability: Primary / Secondary / 4WD trail / (forest maint level).
    road_class: Mapped[str | None] = mapped_column(String, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="MULTILINESTRING", srid=WGS84, spatial_index=True)
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


class AdminForest(Base):
    """A named National Forest administrative boundary, clipped to the focus area.

    Source: USFS EDW Administrative Forest Boundaries (national shapefile,
    https://data.fs.usda.gov/geodata/edw/). This is the *proclaimed* forest
    envelope (e.g. "White River National Forest") — broader than the actual
    FS-managed parcels in `land_ownership`. We keep it because prospecting and
    recreational-mining rules differ per forest, so the Land Status agent needs
    to know which named forest a site sits in to cite the right rules.

    Coverage layer; re-ingest scoped by `state_fips`.
    """

    __tablename__ = "admin_forests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state_fips: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    #: Proclaimed forest name, e.g. "White River National Forest".
    forest_name: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    #: USFS region number (Colorado forests are Region 02).
    region: Mapped[str | None] = mapped_column(String, nullable=True)
    #: USFS forest organizational code (FORESTORGC).
    forest_code: Mapped[str | None] = mapped_column(String, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="MULTIPOLYGON", srid=WGS84, spatial_index=True)
    )


class MiningDistrict(Base):
    """A historic metal-mining district polygon, clipped to the focus area.

    Source: Colorado Geological Survey ON-007-08D, "Historic Metal Mining
    Districts of Colorado" (per-state shapefile). Each polygon names a district
    where metals (gold, silver, …) were historically mined and links to the
    CGS county report PDF (`web_page`). The single highest-signal prospecting
    layer — these are proven-productive ground.

    Coverage layer; re-ingest scoped by `state_fips`.
    """

    __tablename__ = "mining_districts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state_fips: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    #: District name, e.g. "Central City", "Leadville".
    district: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    #: Primary / secondary county the district falls in (CGS text fields).
    county_1: Mapped[str | None] = mapped_column(String, nullable=True)
    county_2: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Link to the CGS county review PDF for this district (provenance).
    web_page: Mapped[str | None] = mapped_column(String, nullable=True)
    #: CGS source citation.
    source: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Boundary caveat, e.g. "Estimated boundary and location."
    note: Mapped[str | None] = mapped_column(String, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="MULTIPOLYGON", srid=WGS84, spatial_index=True)
    )


class MineralPotential(Base):
    """A geologic-unit polygon rated for mineral-resource potential (CGS).

    Source: Colorado Geological Survey "Mineral Resource Potential Derivative
    Map" (ON-007-03), pulled from the CGS ArcGIS MapServer. Each polygon (a
    geologic unit) carries an integer favorability rating (1=low, 2=moderate,
    3=high) per commodity. We keep only polygons where a *prospecting-relevant*
    target rates > 0, and only those target columns — the industrial/aggregate
    commodities (sand, gravel, gypsum, coal) aren't prospecting targets.

    Coverage layer; re-ingest scoped by `state_fips`.
    """

    __tablename__ = "mineral_potential"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state_fips: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    #: Source map-unit/formation code (FMT) for context.
    formation: Mapped[str | None] = mapped_column(String, nullable=True)
    #: 7.5' quadrangle name (QUAD).
    quad: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Favorability ratings (1=low, 2=moderate, 3=high; NULL/0 = not rated).
    au_placer: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    pegmatite: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    corundum: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rare_earth: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fluorite: Mapped[int | None] = mapped_column(Integer, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="MULTIPOLYGON", srid=WGS84, spatial_index=True)
    )


class AmlHazard(Base):
    """An abandoned-mine-land hazard point, clipped to the focus area.

    Source: Colorado Geological Survey ON-008-04, the USFS Abandoned Mine Land
    Inventory geodatabase. We ingest the two physical-hazard layers — mine
    openings (`hazard_kind='opening'`: adits/shafts you could fall into) and
    tailings/waste piles (`hazard_kind='tailings'`). Directly supports the PRD
    requirement to surface hazards when abandoned mines are near a recommendation.

    Coverage layer; re-ingest scoped by `state_fips`.
    """

    __tablename__ = "aml_hazards"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state_fips: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    #: 'opening' (adit/shaft) or 'tailings' (waste/dump pile).
    hazard_kind: Mapped[str] = mapped_column(String, nullable=False, index=True)
    #: Specific feature type, e.g. "adit", "shaft", "mine dump".
    feature_type: Mapped[str | None] = mapped_column(String, nullable=True)
    #: CGS hazard rating, e.g. "potential danger", "no significant hazard".
    haz_rating: Mapped[str | None] = mapped_column(String, nullable=True)
    #: CGS environmental rating where present.
    env_rating: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Field notes / comments.
    comments: Mapped[str | None] = mapped_column(String, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="POINT", srid=WGS84, spatial_index=True)
    )


class MiningClaim(Base):
    """An active BLM mining-claim polygon, clipped to the focus area.

    Source: BLM Mineral & Land Records System (MLRS) "Active Mining Claims",
    served from the BLM ArcGIS MapServer (gis.blm.gov/nlsdb), layer 1. Each
    polygon is a claim case geocoded from its Public Land Survey System (PLSS)
    legal description — ground a third party currently holds mineral rights to on
    public land. We ingest only the ACTIVE layer: it answers "is this ground
    already claimed?", so a prospector avoids trespassing on or duplicating an
    existing claim. Realizes the active-claims layer the PRD deferred to a portal
    link.

    NOTE: PLSS-derived geometry is approximate. This is informational only — like
    land ownership, claim ANSWERS must always carry the disclaimer and never make
    a go/no-go determination. Coverage layer; re-ingest scoped by `state_fips`.
    """

    __tablename__ = "mining_claims"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state_fips: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    #: BLM case serial number, e.g. "COC0123456" — the claim's identifier (CSE_NR).
    serial_nr: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    #: Geographic / claim name where present (CSE_NAME).
    claim_name: Mapped[str | None] = mapped_column(String, nullable=True)
    #: BLM product, e.g. "Placer Mining Claim", "Lode Mining Claim", "Mill Site" (BLM_PROD).
    claim_type: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Record type / case group (REC_TYPE_CSE_GRP).
    case_group: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Case disposition (CSE_DISP) — active for this layer.
    case_disp: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Case acreage (RCRD_ACRS).
    acres: Mapped[float | None] = mapped_column(Float, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="MULTIPOLYGON", srid=WGS84, spatial_index=True)
    )


class Watershed(Base):
    """A HUC12 subwatershed polygon (USGS Watershed Boundary Dataset), clipped
    to the focus area.

    Source: USGS WBD via the TNM ArcGIS MapServer (12-digit hydrologic units).
    Answers "which drainage basin is this point in, and what's downstream"
    (`downstream_huc` = WBD `tohuc`) — placer gold follows drainages, so the
    containing subwatershed is a useful prospecting unit. Coverage layer;
    re-ingest scoped by `state_fips`.
    """

    __tablename__ = "watersheds"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state_fips: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    #: 12-digit hydrologic unit code.
    huc12: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    #: Subwatershed name, e.g. "Upper Clear Creek".
    name: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Downstream HUC this subwatershed drains into (WBD `tohuc`).
    downstream_huc: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Area in square kilometers.
    areasqkm: Mapped[float | None] = mapped_column(Float, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="MULTIPOLYGON", srid=WGS84, spatial_index=True)
    )


class Stream(Base):
    """A natural stream / river / creek flowline (USGS NHD), clipped to the focus area.

    Source: USGS National Hydrography Dataset (NHD), high-resolution Flowline
    (TNM `nhd/MapServer/6`), filtered to PERENNIAL MAIN channels (fcode 46006
    StreamRiver for narrow reaches + fcode 55800 ArtificialPath for the wide
    river main stems, with a visibility-filter threshold) — gold panning needs
    year-round water, so seasonal and capillary streams are dropped. Placer gold
    concentrates in drainages, so trace a creek downhill from a lode/district to
    find where to pan. Pairs with the HUC12 `watersheds` (basins) and the
    field-guide placer advice. (`flow_type` is "Perennial" for all v1 rows.)

    Coverage layer; re-ingest scoped by `state_fips`. License: public domain
    (US Government work, 17 U.S.C. §105).
    """

    __tablename__ = "streams"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state_fips: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    #: NHD permanent identifier (provenance; not guaranteed unique after clipping).
    nhd_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    #: GNIS name where present, e.g. "Clear Creek".
    name: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Flow regime decoded from NHD fcode (Perennial for all v1 rows); popup metadata.
    flow_type: Mapped[str | None] = mapped_column(String, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="MULTILINESTRING", srid=WGS84, spatial_index=True)
    )


class Fault(Base):
    """A mapped geologic fault line (CGS), clipped to the focus area.

    Source: Colorado Geological Survey fault compilation (statewide, ~1:500k,
    from the Tweto state structural map) via the CGS ArcGIS Fault_Server (layer
    15). Faults/fractures are the dominant structural control on lode (hard-rock)
    mineralization — ore deposits cluster along them — so this feeds the
    recommendation engine's lode "proximity to structure" factor. Geometry-only
    (the source carries no usable fault name/type). Coverage layer; re-ingest
    scoped by `state_fips`. License: CGS state-gov data (see docs/DATA_SOURCES.md).
    """

    __tablename__ = "faults"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state_fips: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="MULTILINESTRING", srid=WGS84, spatial_index=True)
    )


class Radiometric(Base):
    """An airborne gamma-ray (radiometric) grid point, clipped to the focus area.

    Source (v1): USGS Bayesian-modeled NURE airborne radiometric prediction grids
    for the conterminous US (West-Central tile, which covers Colorado; DOI
    10.5066/P9YEAFHI, CC0 public domain). Each point carries equivalent thorium
    (eTh, ppm), potassium (%), their ratio, and the model's eTh-exceedance
    probability. Coarse (~1 km), but free and scriptable.

    Thorium highs mark fractionated, "fertile" granites — the parent rock of
    gem-bearing pegmatites — so this feeds the gem profile's 'granite fertility'
    factor for granite-hosted gem targets (pegmatite / corundum / rare-earth). A
    Park County proof-of-concept (2026-06-24) found known gem/pegmatite sites sit
    at the ~80th percentile of eTh vs county background.

    HI-RES UPGRADE: the 50 m Earth MRI "Northeast Block" (DOI 10.5066/P144WOYP) was
    tested as a finer replacement (2026-06-24) and REJECTED — it flies the Mineral
    Belt, not the southern Park / Pikes Peak gem granites (misses Badger Flats;
    signal inverted where it overlaps). NURE stays the gem source; a valid upgrade
    must cover south of 39 N. Coverage layer; re-ingest scoped by `state_fips`.
    See docs/DATA_SOURCES.md.
    """

    __tablename__ = "radiometric"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state_fips: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    #: Equivalent thorium (ppm) — the primary 'fertile granite' signal.
    eth_ppm: Mapped[float | None] = mapped_column(Float, nullable=True, index=True)
    #: Potassium (percent).
    k_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    #: Thorium-to-potassium ratio (secondary fractionation signal).
    th_k: Mapped[float | None] = mapped_column(Float, nullable=True)
    #: Source model probability that eTh exceeds the national median (NURE; for reference).
    exceed_prob: Mapped[float | None] = mapped_column(Float, nullable=True)
    #: Data-source tag, e.g. "NURE-Bayesian" or "EarthMRI-NE-2024".
    source: Mapped[str | None] = mapped_column(String, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="POINT", srid=WGS84, spatial_index=True)
    )


class Trip(Base):
    """A user-created prospecting trip: a named, editable collection of saved
    spots (waypoints) the user wants to visit.

    Unlike the ingested layers, this is *user* data, not downloaded source data —
    so no county/state scoping and no PostGIS geometry. Each waypoint is a
    self-contained SNAPSHOT stored in JSONB: ``{id, lon, lat, title, kind,
    details, note}``. Snapshots (not live links to the layers) keep a trip
    durable and offline-portable — it renders without re-querying and survives
    layer re-ingests. This is the unit the phone export carries into the field;
    the stable per-waypoint ``id`` lets on-site notes merge back on AirDrop
    import. ``updated_at`` supports "newer wins" when reconciling.
    """

    __tablename__ = "trips"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    #: Waypoint snapshots: [{id, lon, lat, title, kind, details, note}, ...].
    waypoints: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
