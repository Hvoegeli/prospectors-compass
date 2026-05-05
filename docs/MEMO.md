# Architecture Memo — Prospector's Compass

## Project Summary

Prospector's Compass is a personal/hobby AI-agent application for hobbyist prospectors and rockhounds. It pairs a desktop web research surface with an iOS field companion, using a LangGraph supervisor + 7 subagent topology over USGS / state-survey / BLM / USFS data, with calibrated verification on every concrete claim. Built under a $10 LLM cost cap during build + initial deploy.

## Key Architecture Decisions

### 1. Multi-agent supervisor + 7 specialist subagents (not single agent)
**Choice:** LangGraph supervisor + Geology, Maps/GIS, Mining History, Land Status, Field Guidance, Specimen ID, Education subagents.
**Rejected:** single monolithic agent with all tools.
**Why:** the seven domains are distinct enough that single-agent prompts grow unwieldy and quality degrades. Specialist agents allow tighter prompts, cheaper Haiku usage per role, and clean audit trails per domain. The supervisor enforces "no claim without citation" centrally.

### 2. Subagents communicate only through the supervisor
**Why:** preserves an auditable reasoning chain. Direct subagent-to-subagent calls introduce hidden state, make debugging hard, and erode the verification guarantee. With supervisor-mediated communication every claim has a clear path to its evidence.

### 3. Claude Haiku 4.5 as default, Sonnet 4.6 only as escape hatch
**Choice:** Haiku 4.5 everywhere by default; Sonnet 4.6 used only when Haiku synthesis visibly fails on a golden eval case.
**Rejected:** Sonnet-default with Haiku for routine work.
**Why:** $10 build cap. Haiku 4.5 is 4–5× cheaper than Sonnet on input and output, supports vision and function calling, and is sufficient for structured subagent reasoning when prompts are tight. Opus is not used at all in v1.

### 4. Prompt caching mandatory across all subagent calls
**Why:** in a multi-agent loop, the supervisor + subagent system prompts and tool definitions account for most input tokens. Caching them cuts cached input cost to ~10% of normal — a >50% savings in the typical query. Non-negotiable given the cost ceiling.

### 5. Single Postgres for spatial AND vector
**Choice:** PostgreSQL with PostGIS + pgvector — one database.
**Rejected:** separate vector DB (Pinecone, Weaviate, Qdrant).
**Why:** simpler infra, fewer moving parts, fits hobby budget. pgvector is fast enough for the corpus we'd realistically ingest (~10K–100K chunks). Co-locating with PostGIS makes spatial-filter + semantic-retrieval joins trivial.

### 6. Local data ingestion (not live federal API calls)
**Choice:** ingest USGS / MRDS / USMIN / BLM / USFS / CGS / TX BEG data into local PostGIS. Refresh land status monthly; refresh other layers on demand.
**Rejected:** live API calls per query.
**Why:** federal APIs are flaky, rate-limited, and slow. The agent loop must be fast and cheap during dev. Static data also makes evals deterministic. The cost is one-time ingestion + monthly refresh of land status.

### 7. Self-hosted MBTiles + MapLibre (not Mapbox paid)
**Choice:** generate MBTiles from USGS topo + DEM hillshade + state geo rasters; serve with TileServer GL on desktop; bundle into mobile for offline.
**Rejected:** Mapbox paid tier.
**Why:** Mapbox per-user pricing doesn't fit a free hobby app, and self-hosting also handles offline mobile (which is what MBTiles was built for). More setup work upfront; eliminates ongoing per-load fees.

### 8. iOS only for v1 (React Native, not native Swift)
**Choices:** (a) iOS only — Android dropped from v1. (b) React Native + Expo, not native Swift.
**Rejected:** Android in v1; native Swift; Flutter.
**Why (Android):** dev capacity is solo; one mobile platform is enough. iOS is the user's primary device.
**Why (RN over Swift):** preserves Android optionality if v2 wants it, shares TypeScript types with desktop, lower stack complexity. Native Swift gives better field perf — flagged for v2 reconsideration if RN's camera/GPS/offline behavior is insufficient.

### 9. Verification policy as a structural contract, not a prompt request
**Choice:** every subagent returns a typed response with `evidence`, `confidence_tag`, `reasoning_chain`. Supervisor enforces "no concrete claim without supporting evidence" before responding. Specimen ID below 60% confidence is structurally prevented from naming the specimen.
**Rejected:** asking the agent in prose to "always cite sources."
**Why:** structural enforcement holds even when the LLM is overconfident. Conflict surfacing requires the same — the structure makes side-by-side reasoning chains a normal output, not a special case.

### 10. Public-domain knowledge corpus only
**Choice:** ingest only public-domain federal pubs and open-access state survey publications.
**Rejected:** copyrighted prospecting books.
**Why:** clean licensing for a hobby project. Federal + state publications cover ~80% of the geology and technique knowledge needed; copyrighted books mostly add color, not core content.

### 11. Light evals, manual snapshot replay, no CI
**Choice:** ~10–20 hand-curated golden cases per launch state, run manually before merging changes.
**Rejected:** full Braintrust/LangSmith CI integration.
**Why:** eval-comfort 1, hobby cadence. Manual snapshot replay catches regressions without CI overhead. Failed user-flagged responses get added to the eval set as it grows. Running evals on every push would defeat the $10 cap.

## Processing Strategy

```
User query (desktop or mobile)
     ↓
Supervisor (LangGraph)
     ↓
Decompose into subagent tasks
     ↓
Dispatch to relevant subagents (parallel where independent)
     ↓
Each subagent:
  - Queries local PostGIS or pgvector
  - Returns {answer, evidence[], confidence_tag, map_features[], reasoning_chain}
     ↓
Supervisor reconciles:
  - Validates "no claim without citation"
  - Flags subagent conflicts → renders side-by-side with full reasoning
  - Surfaces hazards inline (not optional)
  - Surfaces land-status disclaimer + MLRS link-out
     ↓
Synthesized response (with confidence tags + map features) → user
```

## Known Failure Modes

- **Tool failure (USGS API timeout, missing data):** subagent returns structured error → supervisor decides retry / fallback / surface "data unavailable" honestly. No fake answers.
- **Ambiguous user query:** supervisor asks one clarifying question rather than guessing across multiple subagents.
- **Subagent disagreement:** surface both reasoning chains side-by-side rather than picking a winner.
- **Specimen ID overconfidence:** <60% confidence → structurally locked into "field tests" mode; cannot name specimen.
- **Cost overrun during build:** Anthropic alerts at $5 / $8 trigger pause + reassess. `LLM_MOCK_MODE=true` keeps dev iteration free.
- **Stale land-status data:** monthly refresh cadence; "as of [date]" stamp visible on every land-status panel; permanent disclaimer instructing user to verify with the agency.
- **LangGraph state corruption mid-query:** supervisor catches exceptions, returns "agent error" surface to user, logs trace ID for debugging.
- **Mobile offline cache miss:** if user wanders outside cached area, app degrades gracefully — shows last-known position + "no map data for this region; pre-cache before next trip."
- **Prompt cache miss across iterations:** the 5-minute Anthropic cache TTL means tight dev iteration loops keep cache hot; sleeping >5 min between calls invalidates the cache.

## Open Questions Carried Forward

(From `presearch.md` — these need empirical answers during build.)

- **Specimen ID accuracy on Haiku 4.5 vision** — PRD §11 sets ≥80% top-1; needs validation on the test set before locking the model tier.
- **Haiku-vs-Sonnet synthesis threshold** — when does Haiku synthesis fail badly enough to escalate? Measure during eval; threshold TBD by observation.
- **PostGIS hosting in production** — local for dev; if this leaves the laptop, where? Defer.
- **Refresh automation** — monthly land-status refresh is manual initially; whether to script depends on real friction.
