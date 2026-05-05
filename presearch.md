# Presearch — Prospector's Compass

_Date: 2026-05-05_
_Stage: prototype (personal/hobby project)_
_Author: Harrison Voegeli_
_Companion doc: `prospectors_compass_prd.md` (PRD v0.1, same date)_

This document captures the load-bearing decisions made before any code is written, so future work has a clear reference for what was chosen and why.

---

## Phase 1: Constraints

### 1. Domain Selection
- **Domain:** custom — recreational prospecting, rockhounding, and amateur geology (all three).
- **Use cases:** all three of (a) at-home trip planning and research, (b) field navigation + photo specimen ID, (c) self-paced learning about geology and prospecting techniques.
- **Verification policy:**
  1. **Citation-required for concrete claims.** Every specific factual assertion (an area, a mineral, a mine, a formation) must trace to a named source — USGS record ID, MRDS site, state-survey publication, etc. No claim → no source.
  2. **Conflict transparency.** When subagents disagree, surface both verdicts AND each agent's full reasoning chain. Example: if a geological feature is associated with a gemstone statewide but no gem has been recorded at this exact site, the agent must explain that distinction rather than smoothing over it.
  3. **Land status: never go/no-go.** Always show the disclaimer + "verify with the agency" CTA. The agent never says "you can prospect here."
  4. **Specimen ID stays humble.** Confidence band always shown. Below ~60% confidence, default to "here are field tests to differentiate" rather than naming the specimen.
  5. **Hazard surfacing required with details.** Any recommended area with abandoned mines or known terrain risks surfaces those alongside the recommendation, with concrete details — not generic warnings, not in a separate panel.
- **Data sources:** USGS (national geologic map DB, MRDS, USMIN, topo, DEM, NAIP), BLM (land + claims), USFS (forest boundaries), Colorado Geological Survey, Texas Bureau of Economic Geology, plus a curated public-domain knowledge corpus (see §14).

### 2. Scale & Performance
- **Query volume:** single user (Harrison) for the foreseeable future. Maybe a handful of friends in v2.
- **Latency:** ~30s end-to-end for a full multi-subagent recommendation is acceptable. Field/specimen ID needs to feel snappy — target <5s.
- **Concurrency:** 1 user.
- **Cost ceiling:** **$10 hard cap during build + initial deploy.** Aggressive frugality. Hard alerts at $5 and $8 via Anthropic console. Aim to spend well under cap by following the LLM strategy in §6.

### 3. Reliability Requirements
- **Cost of a wrong answer:** mostly a wasted weekend trip. Worst case: a recommendation lands the user on private/restricted land or near a hazardous abandoned mine. Specimen ID misidentification has marginal harm potential.
- **Non-negotiable verification:** citations on every concrete claim, land-status disclaimer surfaced every time, conservative specimen ID (defaults to field tests below confidence threshold).
- **Human-in-the-loop:** none. The user is the human in the loop.
- **Audit / compliance:** none — personal use, no regulated data. Audit only to ensure the app is functional.

### 4. Team & Skill Constraints
- **Team:** solo (Harrison).
- **Agent framework familiarity:** experienced with **LangGraph and LangChain.** Not a first agent build.
- **Domain experience:** "Pete" tier — some panning, casual hobbyist. Not a working geologist.
- **Eval / testing comfort:** **1 out of 5.** Eval tooling must be light-touch — no Braintrust, no CI integration.

---

## Phase 2: Architecture Discovery

### 5. Agent Framework Selection
- **Framework: LangGraph.** Matches existing experience and is purpose-built for the supervisor + subagent topology in the PRD.
- **Topology: multi-agent, supervisor + 7 specialists** (Geology, Maps/GIS, Mining History, Land Status, Field Guidance, Specimen ID, Education/Knowledge). Subagents communicate only through the supervisor — no direct subagent-to-subagent calls — to keep reasoning auditable.
- **State management:** LangGraph `StateGraph` for trip context, conversation memory, and find log.
- **Tool integration:** high complexity — federal + state APIs, PostGIS spatial queries, vision model, vector DB. LangGraph handles this better than rolling custom on the Anthropic SDK.

### 6. LLM Selection
Aggressive frugality to fit the $10 cap.

- **Default everywhere: Claude Haiku 4.5** (`claude-haiku-4-5-20251001`). Has vision, function calling, strong reasoning for structured subagent work. ~4–5× cheaper than Sonnet on both input and output.
- **Claude Sonnet 4.6 as escape hatch only** — used ad hoc when a synthesis case visibly fails on Haiku. Not the default for any tier.
- **Claude Opus 4.7 not used in v1.**
- **Prompt caching mandatory.** Cache supervisor + subagent system prompts + tool definitions across calls. Cuts cached input tokens to ~10% cost — saves ~50%+ in a multi-agent loop.
- **Function calling support:** all Claude models support it natively.
- **Context window:** 200K is ample for subagent state + map data + conversation.
- **Specimen ID:** Haiku 4.5 vision first; Sonnet 4.6 only if Haiku misidentifies common specimens during eval.

### 7. Tool Design
- **Federal data tools:** USGS MRDS, USMIN, geologic map DB, DEM/terrain, NAIP imagery.
- **Land-status tools:** BLM boundaries + claim layer (light surface, see §14), USFS boundaries.
- **State data tools:** Colorado Geological Survey, Texas Bureau of Economic Geology.
- **Spatial tools:** PostGIS for intersection, buffer, watershed delineation, distance.
- **Knowledge tools:** vector search over the public-domain corpus.
- **Vision tool:** specimen photo → Claude vision call.
- **Mock vs real:** **ingest CO + TX data into a local PostGIS once, query locally during dev.** Federal APIs are flaky and rate-limited; local copy makes the agent loop fast and cheap. Refresh land-status data monthly. Refresh other layers as needed (mostly slow-changing).
- **Dev-mode mocks for LLM calls:** wire subagents with canned responses first, swap to real LLM calls only when running canonical eval cases or testing against new queries. Realistic build burn: ~30–60 real LLM calls.
- **Error handling per tool:** structured error returned to supervisor → supervisor decides retry / fallback / "data unavailable" surface to user. No fancy circuit breakers for v1.

### 8. Observability Strategy
- **LangSmith free tier.** Native pairing with LangGraph, ~3 lines of config, traces are essential when a 7-subagent system produces a bad answer.
- **Real-time monitoring:** none.
- **Cost tracking:** Anthropic's dashboard rather than a second system.
- **No CI integration.**

### 9. Eval Approach
- **Golden snapshot replay, hand-curated, no CI.**
- **Case structure:** `evals/cases/` folder — ~10–20 scenarios per state initially.
  - Examples: "placer gold within 2hrs of Denver, beginner," "Texas topaz hunt for a newcomer."
  - Each case: input prompt + structural assertions ("must cite at least one MRDS record," "must include hazard section if recommending area near abandoned mines," "must show land-status disclaimer").
- **Snapshot replay:** record agent's response once it's good; diff against future runs to catch regressions.
- **Manual feedback loop:** thumbs-up/down in the UI; failed responses get added to the eval case folder.
- **No automated CI.** Run evals manually before merging anything that changes the agent.
- **Specimen ID test set:** 50–100 known-label specimen photos (own + open datasets like Mindat). Measure top-1 accuracy.

### 10. Verification Design
- **Subagent contract** (extends PRD §8.10):
  ```
  {
    answer: string,
    evidence: [{source, id, url, confidence_tag}],
    confidence_tag: "high" | "medium" | "low",
    map_features: [geometry],
    reasoning_chain: string  // the *why* behind the verdict
  }
  ```
- **Supervisor enforcement:** before responding, supervisor checks every concrete claim has a supporting evidence item. No evidence → claim stripped or rephrased as "not verified."
- **Confidence tags:**
  - `high` — direct primary record (e.g., MRDS site, USGS map polygon).
  - `medium` — inference from cited regional data.
  - `low` — general knowledge, no specific source.
  - Tags surfaced visibly in the UI.
- **Specimen ID threshold:** <60% confidence → "here are field tests" mode, never names the specimen.
- **Conflict surfacing:** when subagents disagree, supervisor renders both verdicts + both reasoning chains side-by-side.

---

## Phase 3: Post-Stack Refinement (light pass)

### 11. Failure Mode Analysis
- **Tool failure:** subagent returns structured error → supervisor decides retry / fallback / surface "data unavailable" honestly. No fake answers.
- **Ambiguous query:** supervisor asks one clarifying question rather than guessing.
- **Rate limits:** cache aggressively (especially USGS APIs); exponential backoff on retries.
- **Graceful degradation:** if a subagent times out, supervisor synthesizes from what's available + flags the gap.

### 12. Security
- **Prompt injection:** low risk (single-user, no untrusted input). Basic guardrails — don't execute user-quoted text as instructions to subagents.
- **Data leakage:** nothing sensitive (no PII, no proprietary data) → minimal concern.
- **API keys:** `.env` file, gitignored, password manager backup.
- **Audit logging:** not required.

### 13. Testing Strategy
- **Unit tests:** yes for tool functions, especially PostGIS spatial queries (intersection, watershed, buffer) — they break in subtle ways.
- **Integration tests:** golden eval cases from §9 cover this.
- **Adversarial testing:** skip for v1.
- **Regression:** snapshot replay (covered in §9).

### 14. Open Source Planning
- **Skip for v1.** Personal hobby. Revisit if community interest emerges.
- **If released later:** MIT or Apache-2.0; README + this presearch doc as docs floor.

### 15. Deployment & Operations
- **Local dev only for v1.** Run desktop on laptop, mobile via TestFlight (iOS).
- **No CI/CD** — manual runs.
- **Monitoring** = LangSmith free tier.
- **Rollback** = `git revert` (solo).

### 16. Iteration Planning
- **Feedback loop:** thumbs-up/down in UI → failed responses get added to eval case folder.
- **Improvement cycle:** before changing prompts or wiring, run the eval suite; if pass rate drops, fix before merging.
- **Feature prioritization:** PRD phased roadmap (§12) drives it.
- **Maintenance cadence:** solo, async, hobby.

---

## Resolved open questions (from PRD §14)

These were left open in the PRD and resolved during this presearch.

- **Q1 — Knowledge corpus licensing.** Public-domain only for v1. Ingest USGS Open-File Reports, Bulletins, Professional Papers, Circulars; state survey publications from CGS and TX BEG that are open-access; USFS/BLM informational pubs. Skip copyrighted prospecting books (licensing too murky). Wikipedia and forums are reference-only links, not ingested.
- **Q2 — BLM claim data quality.** Light surface. Pull most recent BLM claim layer dump quarterly, render with visible "as of [date]" stamp. **No claim-level interpretation.** Every land-status panel links out to MLRS for verification.
- **Q3 — Specimen ID training.** Prompted Claude vision (Haiku 4.5 first) with GPS-conditioned candidate list from Geology subagent. Optional: 2–3 retrieved reference images for top candidates. Test set: 50–100 known-label photos. Fine-tuning deferred indefinitely; revisit only if prompted approach plateaus below 70% top-1.
- **Q4 — Tile hosting.** Self-host MBTiles. Generate from USGS topo + DEM hillshade + state geologic rasters. Local disk during dev, cheap object storage (S3/R2) later. Mobile offline = MBTiles bundled into app. No Mapbox paid tier.
- **Q5 — Trip-log privacy.** Default-private, no aggregation surface. Deferred per PRD.
- **Q6 — Mobile platform priority.** **iOS only for v1.** Android dropped from Phase 2 scope until later. Harrison's primary devices are Apple.
- **Q7 — Voice interface in field.** Defer to post-v1 per PRD.

---

## Decisions locked in

- **Project name:** Prospector's Compass.
- **Stage:** personal/hobby prototype.
- **Launch states:** Colorado and Texas only (PRD §7.1).
- **Two surfaces:** desktop web app (research) + iOS-only mobile app (field).
- **Architecture:** LangGraph supervisor + 7 subagents.
- **LLM default:** Claude Haiku 4.5 everywhere; Sonnet 4.6 escape hatch only; Opus not used.
- **Prompt caching:** mandatory.
- **Cost ceiling:** $10 hard cap for build + initial deploy.
- **Data strategy:** ingest CO+TX once into local PostGIS; refresh land status monthly.
- **Knowledge corpus:** public-domain federal + state survey publications only.
- **Tiles:** self-hosted MBTiles; no Mapbox.
- **Observability:** LangSmith free tier.
- **Evals:** golden snapshot replay, manual, no CI.
- **Verification:** structured subagent contract with reasoning chains; supervisor enforces "no claim without citation"; conflict-surfacing required; specimen ID <60% → field tests mode.
- **Mobile platform:** iOS only.
- **Open source:** not v1.

---

## Open questions / unresolved

- **Specimen ID accuracy target.** PRD §11 sets ≥80% top-1 on common specimens. Need to validate this is achievable on Haiku 4.5 vision before locking. Prototype gates the answer.
- **PostGIS hosting in production.** Local for dev; if this ever leaves the laptop, where does PostGIS live? Defer.
- **How "good enough" is Haiku 4.5 for supervisor synthesis?** Empirical question — measure during eval. Sonnet escalation rule should fire when Haiku synthesis fails on golden cases >X% of the time. Threshold TBD by observation.
- **CO+TX dataset refresh automation.** Monthly refresh is a manual chore initially; whether to script it depends on real friction.

---

## Next step

Run `/scaffold` to turn this presearch + the PRD into project documentation (`PRD.md`, `TECH_STACK.md`, guardrails, optional skill lifecycle infrastructure). Brownfield mode is appropriate since the PRD already exists.
