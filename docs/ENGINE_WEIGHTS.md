# Engine weights & membership functions (v1)

How the v1 recommendation engine turns the mapped PostGIS layers into a 0–100
favorability score. This is the **deterministic, rule-based "brain"** the project
scope calls for — no model, no training, no randomness. Same inputs → same score,
every run, fully offline.

Source of truth is [`backend/src/prospector/engine/scoring.py`](../backend/src/prospector/engine/scoring.py);
this doc explains *why* the numbers are what they are. If you change a weight or a
ramp, update both.

## The formula

For each grid cell:

```
S = ( Σ wᵢ · fᵢ )  ×  gate_claims  ×  gate_ownership
```

- `fᵢ` — a **0–1 fuzzy membership** of one evidence factor (e.g. "how close is the
  nearest perennial creek"). A raw measurement (meters, degrees, a rating) is mapped
  to 0–1 by a membership function (below).
- `wᵢ` — the factor's **weight**; the weights in a profile sum to **1.0**. So the
  weighted sum is already on a 0–1 scale before gates.
- The combination is a weighted **sum**, deliberately — not fuzzy-gamma or
  weights-of-evidence — so the score is **additively decomposable**: each `wᵢ·fᵢ` term
  *is* the rationale shown in the cell popup. (`× 100` for display.)
- **Gates multiply** and are 0–1, so they can only *suppress*, never reward —
  legality/access can knock a geologically good cell down, but can't invent
  favorability.

Cells below `min_score` (default 0.15) are dropped — low ground isn't surfaced.

## Profiles

Targets map to one of two factor sets. The split mirrors how the deposits actually
form, so each profile only spends weight on evidence that matters for it.

### Placer (`au_placer`) — gold in creek gravels, water/terrain driven

| Factor | Weight | What it measures |
|---|---:|---|
| Known mineralization nearby | **0.35** | fuzzy-OR of: distance to a placer mine, inside/near a district, CGS rating |
| Near a perennial creek/river | **0.25** | distance to a year-round stream |
| Gentle valley grade (placer slope) | **0.20** | slope from the DEM, "Goldilocks" curve |
| Known gold source upstream in basin | **0.20** | a known placer/district lies in this drainage |

Rationale: placer gold is **transported** and **dropped where the current slows**, so
the dominant question is "is there a gold source, and water to carry and concentrate
it." Known mineralization gets the top weight because gold doesn't travel far from
where it eroded out; water proximity and a workable grade are the depositional
controls; the basin-source factor encodes "trace the creek downhill from a lode."

### Lode (`au_lode`, `silver`, `pegmatite`, `corundum`, `rare_earth`, `fluorite`) — hard rock / gems in host rock, geology/structure driven

| Factor | Weight | What it measures |
|---|---:|---|
| Near a known lode mine/prospect | **0.28** | distance to a non-placer MRDS site |
| Near a mapped fault (structure) | **0.22** | distance to a CGS fault line |
| Inside/near a mining district | **0.22** | inside, else distance to a district |
| CGS favorability rating | **0.16** | the CGS mineral-potential rating for this target |
| Favorable host rock | **0.12** | SGMC generalized lithology vs the target |

Rationale: lode ore sits in its **source rock along structures**, so "known vein
nearby + a fault to host it + favorable district/rock" dominates. Faults and
fractures are the primary structural control on hard-rock ore, hence the high
structure weight. The CGS rating is an independent expert signal but coarse
(1:500k-ish), so it's weighted below the direct evidence.

**Renormalization.** `au_lode` and `silver` have **no CGS potential column**, so the
`cgs_potential` factor is structurally dropped and the remaining four weights are
renormalized to sum to 1.0 (`_effective_factors`). A target is never penalized for a
layer that doesn't exist for it.

**Granite fertility (radiometric thorium).** For the **granite-hosted gem targets**
(`pegmatite`, `corundum`, `rare_earth`), the coarse `host_lith` weight (0.12) is
**split in half**: **0.06 stays** on the map-based host-rock proxy and **0.06 moves
to a measured `granite_fertility` factor** — equivalent thorium (eTh) sampled from
the airborne radiometric grid. Thorium marks the *fractionated, fertile* granites
that actually spawn gem pegmatites, so it sharpens the same "favorable granite" theme
without inflating it (the theme keeps its 0.12 total). Other lode targets (`au_lode`,
`silver`, `fluorite`) are **unchanged**. Source: the NURE radiometric grid (≈1 km) in
v1; upgradeable to the 200 m Earth MRI survey — same factor, finer data. See
`docs/DATA_SOURCES.md`.

## Membership functions (raw → 0–1)

- **`ramp_down(d, dmax)`** — linear: 1.0 at distance 0, → 0 at `dmax` m. Used for all
  "near X" factors. Cutoffs: streams 300 m, lode mine 1000 m, fault 1000 m, placer
  mine 1000 m, district 2000 m. (These are the *membership* cutoffs; the SQL uses a
  slightly wider planar pre-filter purely so the spatial index is used.)
- **`placer_slope(deg)`** — non-monotonic "Goldilocks": **0** below 0.5° (dead-flat
  basin floor) and above 25° (cliffs shed, don't trap), ramping to a **1.0 plateau
  over 2–10°** — the gentle valley grades where a steepening-then-flattening creek
  drops its gold.
- **`reclass_rating(r)`** — CGS rating 1/2/3 → **0.3 / 0.6 / 1.0** (super-linear, so a
  "high" rating counts for much more than three "lows").
- **`host_lith_score(lith, target)`** — coarse SGMC lithology favorability;
  pegmatite/corundum favor intrusive (1.0) / metamorphic (0.7) hosts, generic lode
  favors igneous/metamorphic (0.7) over sediments (0.3). A rough v1 proxy — the
  honest weakness here is the 1:500k geology; refine when finer geology is bundled.
- **`radiometric_fertility(th_ppm)`** — equivalent-thorium (ppm) → 0–1: **0 at 8 ppm**
  (≈ regional background median), ramping to **1 at 12 ppm** (≈ 90th percentile),
  clamped. Thorium flags the fractionated, fertile granites that host gem pegmatites.
  Thresholds come from a Park County proof-of-concept (2026-06-24) where known
  gem/pegmatite sites sat at the ~80th percentile of eTh vs county background. Drives
  the `granite_fertility` factor for granite-hosted gem targets.
- **`fuzzy_or(*v) = 1 − ∏(1 − vᵢ)`** — combines the **correlated** sub-signals of the
  placer "known mineralization" super-factor (a placer mine, a district, and a CGS
  rating tend to co-occur). A plain sum would double-count the same fact; fuzzy-OR
  saturates toward 1 instead of stacking past it.

## Gates (0–1 multipliers)

- **`gate_claims`** — **0.0** if the cell is inside an active BLM mining claim, else
  1.0. Ground that's already staked is zeroed out: you can't claim it, so it's not a
  recommendation no matter how good the rock.
- **`ownership_gate(manager)`** — access by land manager, mirroring the map's
  ownership grouping: **BLM / USFS = 1.0** (open to entry), **other federal = 0.6**,
  **state / unknown = 0.5**, **private = 0.2** (needs permission). Private isn't
  zeroed — it's a real but discounted option (you *can* ask the landowner).

**AML mine hazards are never folded into the score.** Safety is surfaced separately
(the Mine hazards layer / field-guide warnings), not traded off against favorability —
a dangerous adit doesn't make ground "less prospective," it makes it dangerous.

## Where the weights come from & how to tune them

These are **starting expert (AHP-style) weights** — pairwise "is structure more
important than a known mine for lode?" judgments, normalized per profile to sum to 1.
They are intentionally round and legible, not fit to data (there's no labeled
training set, and a deterministic, explainable v1 is the point).

To tune: change a `Factor(...)` weight or a membership cutoff in `scoring.py`, keep
each profile's weights summing to 1.0 (or let `_effective_factors` renormalize), and
re-check a few known spots (e.g. Leadville should score high for lode; a creek below a
district should score high for placer). Because the engine is deterministic, a weight
change is fully auditable — the per-factor contributions in the popup show exactly
what moved.
