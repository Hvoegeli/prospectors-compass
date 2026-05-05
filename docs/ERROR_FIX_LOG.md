# Error & Fix Log — Prospector's Compass

## Template

When an error or fix takes more than 5 minutes to diagnose, append an entry below in this format:

```
### YYYY-MM-DD — Short error title

**Error:** <exact error message or symptom>
**Context:** <what you were doing, which file, which command>
**Root cause:** <why it happened>
**Fix:** <what you changed to resolve it>
**Prevention:** <what would catch this earlier next time>
```

**Log:** build failures, runtime errors, API errors (USGS / BLM / Anthropic), database errors (PostGIS / pgvector), deployment errors, integration failures.

**Do NOT log:** typos, linter warnings, expected test failures (e.g., a snapshot diff that's an intentional change).

## Log

*No errors logged yet.*

## Common Issues to Watch For

### LangGraph
- **Cached node skipped on rerun:** LangGraph caches node results by state hash; if you change a node's logic but the state hash matches a prior run, it returns cached output. Bump state schema or clear the checkpointer when iterating.
- **Tool call schema mismatch:** subagent returns a Pydantic-typed response that doesn't match the supervisor's expected contract → supervisor either silently drops the field or errors. Validate the contract on every subagent return.
- **Parallel branch starvation:** if one subagent in a parallel fan-out hangs, the supervisor can wait indefinitely. Set per-subagent timeouts.

### Anthropic SDK / prompt caching
- **Cache miss on every call:** prompt caching only applies to message blocks marked with `cache_control`; system prompts and tool definitions need explicit cache markers. Verify by inspecting `cache_creation_input_tokens` vs `cache_read_input_tokens` in response metadata.
- **Cache TTL is 5 minutes:** sleeping >300s between calls invalidates the cache. Batch dev iteration tightly or accept the cache miss.
- **Vision call cost surprise:** image tokens are charged in addition to prompt tokens — a high-res photo can be ~1500 tokens. Resize images client-side before upload.
- **Function-call argument truncation:** if the model returns a tool call with a giant JSON arg, watch for serialization issues. Prefer multiple small tools over one mega-tool.

### PostGIS
- **`ST_Intersects` slow without GIST index:** every spatial table needs `CREATE INDEX ... USING GIST (geom)`. Verify with `EXPLAIN ANALYZE`.
- **SRID mismatch:** mixing SRID 4326 (WGS84) and SRID 3857 (web mercator) silently returns empty results. Standardize on 4326 storage; transform on the fly when needed.
- **Watershed delineation expensive:** `ST_DWithin` over a DEM-derived flow grid can take seconds. Pre-compute watersheds for known drainage basins where possible.
- **`ST_Buffer` in degrees vs meters:** a 0.01-degree buffer is not the same everywhere. Use `geography` type or transform to a meter-based SRID for accurate buffering.

### pgvector
- **`ivfflat` index needs `ANALYZE`:** create the index, then run `ANALYZE corpus_chunks` for the planner to use it.
- **Embedding dimension mismatch:** `VECTOR(1536)` is hardcoded; if you change the embedding model, you must drop and recreate the column.
- **Cosine vs L2 distance operator confusion:** `<=>` is cosine, `<->` is L2. Use the matching `vector_cosine_ops` index class.

### React Native + Expo
- **Expo Go vs dev build:** MapLibre Native often requires a dev build, not Expo Go. Run `eas build --profile development` if maps don't render.
- **iOS simulator can't reach `localhost`:** use the machine's LAN IP for the API base URL on simulator.
- **Background GPS drains battery:** use `Location.watchPositionAsync` with `accuracy: Balanced` or `Low` while idle; switch to `High` only when actively logging finds.
- **Magic-link deep link not opening app:** verify URL scheme and `expo-linking` config in `app.json`.

### MapLibre GL JS
- **Tile 404 cascades silently:** missing tiles render as transparent. Check the network tab and TileServer GL logs.
- **Mixed-content errors:** if API is HTTPS but TileServer is HTTP, browser blocks tile requests. Run TileServer behind HTTPS in any non-localhost scenario.
- **Style spec changes between minor versions:** lock the MapLibre version and the style JSON together.

### FastAPI
- **SSE response not streaming:** intermediate proxies (uvicorn behind nginx) buffer SSE by default. For dev, run uvicorn directly. For prod, set `proxy_buffering off`.
- **Pydantic v2 serialization changes:** `dict()` is deprecated, use `model_dump()`. Watch out for nested-model serialization quirks.
- **Async/sync DB driver mixup:** with SQLAlchemy 2 + asyncpg, use the async session everywhere or it'll deadlock on first request under load.

### Auth / magic links
- **Token replay:** magic-link tokens must be single-use. Mark as consumed in the DB on first verification, even if downstream session creation fails.
- **Resend free tier rate limits:** 100 emails/day. Fine for hobby use, but log failures and fall back to manual retry.
- **Clock skew on JWT verify:** allow a small `leeway` (~30s) on `exp` to avoid spurious "token expired" errors.

### Eval suite
- **Snapshot diff explodes on whitespace:** normalize whitespace and trailing punctuation before diffing the synthesized answer field.
- **Subagent nondeterminism:** with `temperature > 0` even golden cases can fluctuate. Set `temperature=0` for eval runs.
- **Missing trace URL:** if LangSmith env vars aren't set, runs succeed but trace_url is null and debugging fails. Fail loudly when LangSmith is misconfigured during eval.
