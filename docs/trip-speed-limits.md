# Trip speed-limit enrichment — AB#72

**Current scoring:** Task 73 now consumes these stored limits; see
[`per-limit-scoring.md`](per-limit-scoring.md). Statements below describing the
unchanged 80+5 scoring describe the Task 72 implementation boundary.

When enabled, `POST /api/end-trip` enriches a trip's stored GPS samples **before**
the existing scoring call. The phone sends the same raw samples as before; neither
the TomTom key nor provider requests go through the frontend. No new public route.

Task 72 stores provider lookup results. The existing scoring formula/80+5 threshold
is deliberately unchanged: consuming per-sample limits, choosing the 85 km/h
fallback rule, recording the effective scoring threshold/tolerance, and changing
minimum distance belong to subsequent scoring work. Until that work, these are
fetched limits, not a claim that the current score used them. Do not enable
per-limit scoring merely by enabling this enrichment switch.

## Storage

Apply `database/004_trip_speed_limits.sql` manually to the intended Supabase
environment before enabling. This migration has not been executed by the coding
agent. It creates:

- `trip_sample_speed_limits`: one row per GPS `sample_id`, with `speed_limit_kmh`
  (nullable), `lookup_status`, `provider`, `fetched_at`, and provider segment ID.
  Join it to `trip_data_points` using `sample_id`; raw timestamps/coordinates/speeds
  are preserved. GPS rows are those with both coordinates present; motion-only
  rows are not sent to TomTom.
- `trip_speed_limit_runs`: a trace hash, completion state, and a three-minute
  lease/token to prevent duplicate simultaneous requests and partial writes.
  RPC functions are executable only by `service_role`; both tables have RLS with
  no frontend access policy. Completion is transactional and checks sample IDs,
  timestamps, coordinates, count, and lease before saving.
- A trigger prevents raw insert/update/delete after a trip leaves `Active`.
  Uploads now return 409 for ended trips; this protects historical results.
  The existing frontend already uploads before calling end-trip. Do not use the
  old upload endpoint to replace samples on a completed trip.

Available limits are positive, maximum automobile limits in km/h. A matched road
without a supported numeric limit is `missing`; other unsnapped points are
`unmatched`. An isolated GPS point that cannot form a trace is
`insufficient_trace`. All these store null limits, never a guessed road speed.
HTTP/auth/quota/timeouts and malformed responses are errors, not missing data.

## Configuration

Use the **backend Vercel project** environment settings:

| Variable | Value / purpose |
| --- | --- |
| `TOMTOM_API_KEY` | Secret, with Snap to Roads access; no public/Expo prefix |
| `TRIP_SPEED_LIMIT_ENRICHMENT_ENABLED` | `false` or absent by default; `true` enables fetching |
| `TOMTOM_TIMEOUT_MS` | Optional; default 10000, maximum 15000 per request |
| `TOMTOM_MAX_REQUESTS_PER_TRIP` | Optional; default/maximum 8 total calls per attempt, including subdivision |

An enabled switch requires a valid key. Invalid config or failed lookup returns
503 `{ "error": "trip_speed_limits_unavailable" }`; the trip stays `Processing`.
Retry **end-trip**, not upload. Successful enrichment is reused on retries even
if scoring later fails. A crashed request's lease expires after three minutes;
a concurrent retry receives 503 until the lease is released/expired. A completed
trip returns its stored result without lookup or rescore. Old completed trips are
not backfilled. No keys, provider URLs, raw response bodies or GPS data are logged.

The eight-call attempt cap limits quota use; repeated client attempts still count
and should be monitored in TomTom. Calls within a trip are spaced at least 250 ms;
multiple trips share account QPS, so 429 is an explicit retryable failure. This
PoC does not add a distributed global rate limiter or background queue.

## Long traces and identity

The adapter prepares chunks of at most 4900 points and approximately 80 km of
GPS distance, leaving margin below TomTom's 5000-point/100-km limits. GPS distance
cannot guarantee routed distance. If the provider rejects a chunk with HTTP 400,
it subdivides with a one-point overlap, bounded by the total request budget.
Two-point rejections remain failures; other HTTP failures are not automatically
retried. Obvious GPS jumps of 5 km or more start a separate trace.

Overlap is merged by `sample_id`: the first chunk owns the boundary result,
including unknown results. Duplicate timestamps are preserved as separate stored
samples, never used as a lookup key. Real stored timestamps are sent to TomTom.
This differs from the research CSV PoC, whose unknown timezone required omission.

Limits are normalized behind `SpeedLimitProvider`; scoring must not depend on
TomTom's route indices or response shape. Another provider can implement the
same interface. No second provider is built here.

## Verification / rollout

```powershell
node --test tests/*.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Tests cover input identity, known/unknown/unmatched responses, metric limit
semantics, point/distance splitting, gap handling, overlap, HTTP subdivision,
quota/error behavior, secret-safe exceptions, cache/lease behavior, persistence
failure, and server configuration. Provider and repository calls are mocked;
no key, live quota, database, or application network access is required.

Before enabling in Preview:

1. Review/apply migration 004 to a test database. Verify its RPCs/trigger using
   `tests/trip-speed-limits.sql` (transaction rolls back test rows).
2. Add the backend key/config and deploy the branch. Confirm deployment supports
   the configured 180-second `end-trip` duration (`vercel.json`). Existing client
   HTTP timeouts may close first; retrying is safe after the lease completes.
3. Enable enrichment in Preview. Start a new trip, upload stored GPS and motion
   samples, then end it. Verify the following query returns one lookup per GPS
   sample, nulls only with a non-available status, and provider/fetch date.
4. Retry end-trip: provider usage and saved fetch timestamps should not change.
   Verify an old completed score is unchanged. Test a 401/429/timeout in a test
   environment: no completed lookup or score should be committed by that attempt.

```sql
SELECT d.sample_id, d.recorded_at, d.latitude, d.longitude, d.speed_kmh,
       l.speed_limit_kmh, l.lookup_status, l.provider, l.fetched_at
FROM public.trip_data_points d
LEFT JOIN public.trip_sample_speed_limits l USING (sample_id, trip_id)
WHERE d.trip_id = '<new-test-trip-id>'
  AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL
ORDER BY d.recorded_at, d.sample_id;
```

Production activation, database migration, deployment, and live end-to-end
verification are not performed by local unit/type checks. Confirm provider
Evaluation duration and storage/scoring rights as recorded by Task 70.
