# Testing Strategy — Prospector's Compass

## Testing Pyramid

For a hobby project with eval-comfort 1, the pyramid is intentionally inverted from production norms:

- **40% Eval suite** — golden snapshot replay over the agent system end-to-end. This is the primary correctness signal because LLM outputs aren't unit-testable.
- **40% Unit tests** — narrow tests for spatial query helpers (PostGIS), data ingestion parsers, verification-policy enforcement, and prompt-cache wiring.
- **15% Integration tests** — boundary tests for backend API (FastAPI) → DB (PostGIS) → cached subagent paths.
- **5% E2E** — manual smoke tests on desktop + mobile before any merge to main. No automated browser/device tests in v1.

## Coverage Targets

| Layer | Target | Tool |
|---|---|---|
| Spatial helpers (PostGIS) | 100% of public functions | pytest |
| Data ingestion parsers | every dataset has at least one happy + one malformed-record test | pytest |
| Subagent contract validation | every subagent has a contract test | pytest + pydantic |
| Prompt cache wiring | unit test asserts cache_control marker on supervisor + subagent system prompts | pytest with mocked Anthropic client |
| Eval golden cases (CO + TX) | ≥ 20 cases at v1 release | snapshot replay runner |
| Specimen ID accuracy | ≥ 80% top-1 on common specimens | manual labeling on 50–100 photo set |
| Specimen ID calibration | "high confidence" → correct ≥ 90% | calibration check |
| Cost guardrail (build phase) | < $10 total spend | Anthropic dashboard + per-run cost log |

## Test Categories

### Unit (pytest)
- **Spatial functions:** watershed delineation, buffer correctness, intersection edge cases (null geom, multipolygon, antimeridian crossing).
- **Ingestion:** MRDS / USMIN / land-status parsers given fixture rows; verify SRID handling and `as_of` stamping.
- **Verification policy:** assert that supervisor strips a no-evidence claim; assert that `confidence_tag` flows end to end; assert specimen ID below 60% sets `naming_locked: true`.
- **Prompt caching:** mocked Anthropic client; assert cache_control markers exist on system prompt and tool-definition message blocks.
- **Cost accounting:** assert per-run cost log records token counts and dollar conversions correctly.

### Integration (pytest + test DB)
- API → DB: trip CRUD round-trip with PostGIS area geom.
- API → agent (with `LLM_MOCK_MODE=true`): supervisor returns expected structure on canned subagent responses.
- Auth: magic-link request → verify → session token usable for trip CRUD.
- Mobile sync simulation: trip created on desktop appears on mobile via API; finds appended from mobile flow back to desktop.

### Eval (snapshot replay)
- `evals/cases/<state>/<scenario>.json` — input prompt + structural assertions (e.g., "must cite at least one MRDS record," "must include hazard section if recommending area near abandoned mines," "must show land-status disclaimer").
- Runner records full subagent trace to LangSmith and serializes the synthesized answer.
- Diff against committed snapshot. Failed cases require human review (regression vs. intentional change).
- `temperature=0` for all eval runs to minimize nondeterminism.

### Specimen ID accuracy
- 50–100 known-label photos in `evals/specimens/`.
- Top-1 accuracy on common specimens (pyrite, gold, quartz, garnet, topaz, mica, magnetite, etc.).
- Calibration check: high-confidence cases must be ≥ 90% correct.
- Run before any change to the Specimen ID prompt or model tier.

### Manual smoke (E2E)
- Pre-merge checklist:
  - Desktop: trip planning flow (Flow A from `docs/USER_FLOW.md`) end-to-end with one CO and one TX query.
  - Area export → mobile import works with no signal.
  - Mobile: GPS find logging round-trip (Flow B).
  - Specimen photo capture → agent response → log find.
- Run against local dev stack only; no automated mobile testing in v1.

## CI Integration

**v1: none.**

Reasoning: the eval suite touches the live Anthropic API and burns budget. Running it on every push would defeat the $10 cap. Manual gating preserves human control over when real LLM calls fire.

If/when this changes:
- Unit + integration tests can run in CI on PR (no LLM calls).
- Eval suite remains manual dispatch only (`workflow_dispatch`), with budget guard that aborts if monthly spend > $X.

## Requirement Coverage Matrix

| Requirement | Test Surface |
|---|---|
| [MVP1] Region selector | manual smoke; integration test for state filter on agent endpoint |
| [MVP2] Target material selection | unit test for valid material enum; eval cases per material |
| [MVP3] LangGraph supervisor + subagents | contract unit tests per subagent; eval suite end-to-end |
| [MVP4] Local data ingestion | ingestion unit tests per dataset (happy + malformed) |
| [MVP5] Spatial query tools | unit tests (100% coverage target on public functions) |
| [MVP6] Recommendation engine | eval cases (~10 per state) |
| [MVP7] Verification policy enforcement | unit tests on supervisor enforcement; eval-case structural assertions |
| [MVP8] Land-status disclaimer | unit test asserting disclaimer in every land-status response; eval-case assertion |
| [MVP9] Interactive desktop map | manual smoke |
| [MVP10] Knowledge corpus + pgvector | retrieval unit test; eval cases for Education subagent |
| [MVP11] iOS mobile app + offline maps | manual smoke; integration test for area-export endpoint |
| [MVP12] GPS / waypoints / find-pins | integration test for find sync; manual smoke |
| [MVP13] Specimen ID | accuracy harness on 50–100 photos; calibration check; unit test for <60% naming lock |
| [MVP14] Trip log + sync | integration test (desktop create → mobile read; mobile finds → desktop) |
| [MVP15] Eval suite + LangSmith | eval suite tests itself; LangSmith trace presence asserted in eval runner |
| [MVP16] Cost guardrails | unit test on prompt-cache markers; per-run cost log; build-phase total spend < $10 |
