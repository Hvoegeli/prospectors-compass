"""Download regions — a state plus a chosen set of counties.

The app's download capability is region-parameterized: a user picks a state on a
map, then selects which counties to pull data for (see PRD Group 8 desktop map).
A `DownloadRegion` is exactly the result of that selection — a state FIPS code
plus a tuple of `County` objects. The ingestion engine takes a `DownloadRegion`
as input and clips every source layer to those counties.

v1 ships ONE pre-built region — the I-70 corridor (`I70_CORRIDOR`), the 10
counties of PRD §7.1 — and wires data sources for Colorado only. A user in
another state would simply produce a different `DownloadRegion`; the engine code
does not change. Defined here ONCE so the v1 scope can't drift between datasets.

County FIPS codes are the standard US Census identifiers: a 2-digit state code
(Colorado = "08") + a 3-digit county code, concatenated into a 5-digit GEOID
(e.g. Denver = "08031"). GEOIDs are how we select counties out of the statewide
Census TIGER/Line boundary file that becomes a region's clip mask.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Census state FIPS code for Colorado.
COLORADO_STATE_FIPS = "08"


@dataclass(frozen=True)
class County:
    """One county and its Census identifiers, scoped to a state."""

    name: str
    #: 3-digit county FIPS code (within its state).
    county_fips: str
    #: 2-digit state FIPS code this county belongs to.
    state_fips: str

    @property
    def geoid(self) -> str:
        """5-digit state+county GEOID used to select this county from TIGER data."""
        return f"{self.state_fips}{self.county_fips}"


@dataclass(frozen=True)
class DownloadRegion:
    """A state plus the counties a user chose to download data for.

    This is the unit the ingestion engine operates on, and the shape the future
    county-picker UI will emit.
    """

    name: str
    state_fips: str
    #: USPS state abbreviation, e.g. "CO" — needed for per-state source URLs.
    state_abbrev: str
    counties: tuple[County, ...]

    def geoids(self) -> list[str]:
        """5-digit GEOIDs for the chosen counties (for filtering TIGER data)."""
        return [c.geoid for c in self.counties]

    def county_names(self) -> list[str]:
        """Human-readable county names, e.g. for log lines and source attribution."""
        return [c.name for c in self.counties]


def _co(name: str, fips: str) -> County:
    return County(name, fips, COLORADO_STATE_FIPS)


#: The v1 default region — the I-70 corridor focus area (PRD §7.1).
#: Order: Denver metro outward along I-70 toward Grand Junction.
I70_CORRIDOR = DownloadRegion(
    name="Colorado — I-70 Corridor (v1 default)",
    state_fips=COLORADO_STATE_FIPS,
    state_abbrev="CO",
    counties=(
        _co("Denver", "031"),
        _co("Jefferson", "059"),
        _co("Clear Creek", "019"),
        _co("Gilpin", "047"),
        _co("Park", "093"),
        _co("Summit", "117"),
        _co("Lake", "065"),
        _co("Eagle", "037"),
        _co("Garfield", "045"),
        _co("Mesa", "077"),
    ),
)

#: v1 ingestion targets this region unless a caller passes a different one.
DEFAULT_REGION = I70_CORRIDOR
