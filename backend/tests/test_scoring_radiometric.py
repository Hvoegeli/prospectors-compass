"""Unit tests for the radiometric 'granite fertility' scoring factor (no DB).

Covers the thorium→membership ramp and the target-specific factor wiring: only
granite-hosted gem targets gain the thorium factor, it is carved from the
host-lithology weight, and every target's effective weights still sum to 1.0.
"""

import pytest

from prospector.engine.scoring import (
    GRANITE_FERTILITY_TARGETS,
    TARGETS,
    _effective_factors,
    radiometric_fertility,
)


def test_radiometric_fertility_ramp():
    assert radiometric_fertility(None) == 0.0
    assert radiometric_fertility(8.0) == 0.0  # background median → no credit
    assert radiometric_fertility(10.0) == pytest.approx(0.5)
    assert radiometric_fertility(12.0) == 1.0  # ~P90 → full
    assert radiometric_fertility(25.0) == 1.0  # clamps above 12 ppm


def test_only_granite_targets_get_thorium_factor():
    for target, spec in TARGETS.items():
        names = [f.name for f in _effective_factors(spec)]
        if spec.potential_col in GRANITE_FERTILITY_TARGETS:
            assert "granite_fertility" in names, target
            assert "host_lith" in names, target  # kept, at half weight
        else:
            assert "granite_fertility" not in names, target


def test_effective_weights_sum_to_one():
    for target, spec in TARGETS.items():
        total = sum(f.weight for f in _effective_factors(spec))
        assert total == pytest.approx(1.0), target


def test_thorium_weight_carved_evenly_from_host_lith():
    """The favorable-granite theme splits 50/50 between map proxy and thorium."""
    weights = {f.name: f.weight for f in _effective_factors(TARGETS["pegmatite"])}
    assert weights["granite_fertility"] == pytest.approx(weights["host_lith"])


def test_non_granite_lode_weights_unchanged_by_feature():
    """Adding the thorium factor must not perturb non-granite lode targets.

    Fluorite is a lode target with a potential column but is not granite-hosted, so
    its factor set/weights should be the classic lode mix (host_lith at full 0.12).
    """
    weights = {f.name: f.weight for f in _effective_factors(TARGETS["fluorite"])}
    assert "granite_fertility" not in weights
    assert weights["host_lith"] == pytest.approx(0.12)
