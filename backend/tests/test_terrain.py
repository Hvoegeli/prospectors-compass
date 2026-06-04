"""Unit tests for the DEM cell-naming math (pure; no network or GDAL needed)."""

from prospector.ingest.terrain import dem_cells


def test_i70_corridor_cells():
    """The I-70 corridor bbox covers a 3×6 block of 1° cells (18 total)."""
    cells = dem_cells((-109.06, 38.7, -104.6, 40.2))
    assert len(cells) == 18
    # NW corner naming: nNN spans [NN-1, NN] lat; wWWW spans [-WWW, -WWW+1] lon.
    assert "n39w105" in cells  # SE-most cell
    assert "n41w110" in cells  # NW-most cell
    assert "n40w107" in cells  # covers Denver-ish (39.3, -106.4)


def test_zero_padding():
    """Cell names zero-pad lat to 2 and lon to 3 digits (USGS convention)."""
    cells = dem_cells((-100.5, 38.5, -100.5, 38.5))
    assert cells == ["n39w101"]


def test_single_degree_point():
    """A point well inside one cell yields exactly that cell."""
    # (39.3, -106.4) → north=ceil(39.3)=40, west=ceil(106.4)=107.
    assert dem_cells((-106.4, 39.3, -106.4, 39.3)) == ["n40w107"]


def test_covers_all_intersecting_cells():
    """A bbox straddling a degree line picks up cells on both sides."""
    # lon −106.4..−105.6 straddles −106 → wests {106, 107}; lat 39.2..39.8 → north {40}.
    cells = dem_cells((-106.4, 39.2, -105.6, 39.8))
    assert set(cells) == {"n40w106", "n40w107"}
