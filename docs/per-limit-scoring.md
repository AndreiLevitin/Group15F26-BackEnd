# Per-limit speeding events — AB#73

**Review follow-up:** 004 and 005 contain the final development schema.
TypeScript owns scoring business rules; SQL validates audit structure without
recomputing event semantics. Existing databases created from earlier versions
need the targeted update described in [review decisions](review-72-73-decisions.md),
not a second execution of the CREATE TABLE scripts.

The end-trip flow now uses the limits stored by Task 72. No frontend API contract
change, new provider call, or new penalty formula is introduced by scoring.

## Rules

- Join GPS readings to stored limits by `sample_id`, never by timestamp/index.
- Available posted limit: `threshold = road limit + TRIP_SPEED_TOLERANCE_KMH`.
- No stored numeric limit: `threshold = TRIP_FALLBACK_SPEED_THRESHOLD_KMH`.
  The agreed fallback is **85 km/h as a final threshold**; no additional tolerance.
- Speeding requires `speed > threshold`; equality is not speeding.
- Consecutive speeding representative readings are one event, including across
  road-limit changes and fallback portions. A non-speeding reading ends the event.
- Invalid GPS/speed/time rows are ignored. They do not invent a normal reading
  or split an existing event. No new time-gap/minimum-event-duration rule is added.
- Duplicate timestamps still keep the highest valid speed. Its OWN stored limit
  travels with it; equal-speed ties choose the lowest sample ID for determinism.
  Other samples at that timestamp are marked `duplicate` and not scored twice.
- Keep the existing formula and rounding:
  `round(clamp(100 - penaltyPerEvent * speedingEvents / distanceKm, 0, 100))`.
  The penalty continues to come from `TRIP_SPEEDING_PENALTY_PER_EVENT` (deployed
  value 2); this task does not change it.
- Minimum sample count and distance still gate scoring; insufficient trips keep
  a null score. The minimum distance is inclusive.

## Configuration and activation

Add these **backend** environment variables before deploying/enabling the new code:

| Variable | Setting |
| --- | --- |
| `TRIP_SPEED_TOLERANCE_KMH` | **5**, confirmed by the user |
| `TRIP_FALLBACK_SPEED_THRESHOLD_KMH` | **85**, final fallback threshold |
| `TRIP_SPEEDING_PENALTY_PER_EVENT` | Keep existing **2** |
| `TRIP_MIN_VALID_READINGS` | Keep existing **5** |
| `TRIP_MIN_DISTANCE_KM` | **0.1 proposed** for this PoC; user has not yet confirmed the replacement of 0.0001 |

Both new settings are required, finite, validated and server-only. No numeric
fallback/tolerance defaults are hardcoded in runtime scoring. Keep the Task 72
TomTom key and `TRIP_SPEED_LIMIT_ENRICHMENT_ENABLED=true` for normal enrichment.
If enrichment is deliberately disabled, absent stored limits are explicitly
fallback-scored. A provider/DB error is still an error, not missing road data.

Per-limit scoring replaces the old calculation for newly ended trips on this
deployment; there is no second per-limit feature flag. Before rollout, record
the team's chosen minimum distance on the Story as required by AC10. Local tests
using 0.1 do not constitute that approval or a server configuration change.

## Persistence and reproducibility

Apply `database/005_per_limit_scoring.sql` after 004. It creates two RLS-protected
tables and a service-role-only transaction function; it does not backfill or
recalculate any historical trip.

- `trip_scoring_results`: one immutable-on-repeat result per trip, including
  version, exact calculation distance (before the `trips.distance_km` rounding),
  counts, event count, score/unscored reason and every scoring configuration value.
- `trip_sample_scoring`: one decision per GPS sample with status
  `used/duplicate/ignored/unscored`. A `used` sample records the actual limit,
  applied tolerance, final threshold, `used_fallback`, `is_speeding`, and
  `starts_event`. Non-used rows have null flags/thresholds, so duplicates or
  insufficient trips are not falsely labelled as fallback-scored.

For fallback, `speed_limit_kmh_used=85`, `tolerance_kmh_used=0`,
`threshold_kmh=85`, `used_fallback=true`. This is a scoring rule, not a claim that
the legal posted limit is 85; the separate fetched limit remains null. Available
limits retain Task 72 provider/fetch provenance in `trip_sample_speed_limits`.

The RPC atomically stores decisions, config and score before setting Completed.
It verifies complete sample identity/counts and structural audit consistency.
Threshold selection and event boundaries are calculated in TypeScript.
A failure rolls back all scoring writes. A completed trip
returns the old result without overwriting its score or audit rows, including
trips recorded before this task. A completed end-trip can be returned even if the
new scoring variables are missing; no rescore is attempted.

## Tests and worked example

```powershell
node --test tests/*.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Hand-calculated 0.3 km fixture (penalty 2, tolerance 5, fallback 85):

| Speed | Stored limit | Threshold | Fallback | Speeding | New event |
| --- | --- | --- | --- | --- | --- |
| 55 | 50 | 55 | no | no | no |
| 56 | 50 | 55 | no | yes | yes |
| 70 | missing | 85 | yes | no | no |
| 86 | missing | 85 | yes | yes | yes |
| 65 | 60 | 65 | no | no | no |

Two events: `round(100 - 2*2/0.3) = 87`. Tests also cover zero events/100,
speeds above 85 that remain legal on higher-limit roads, speeding below 85 on
lower-limit roads, exact boundaries, minimum distance, continuous events across
changing limits, duplicates with conflicting limits, invalid data/config and
failed saves. The SQL integration test is `tests/per-limit-scoring.sql`; run it
in the development Supabase SQL Editor after migration 005. It rolls back test
rows and verifies atomic writes, fallback flags, event counts, snapshot config,
and completed-trip immutability. It was prepared locally, not executed by the agent.

Offline replay of the saved Task 70 TomTom response, with tolerance 5, fallback 85,
penalty 2 and minimum 0.1: 622 raw samples, 616 representative readings, 6
duplicates, 10 events, distance 6.6377272886 km, score 97. Of the representative
readings, 93 use fallback. This is not a new live/provider or database test;
provider data and duplicate tie choices on a new trip can differ.

## Preview verification

After migration/config/deploy, use `scripts/verify-speed-limit-preview.mjs` against
the NEW deployment URL. It creates a new test trip. Inspect the following with
its returned trip ID:

```sql
SELECT * FROM public.trip_scoring_results WHERE trip_id = '<new-trip-id>';

SELECT s.status, s.used_fallback, count(*) AS samples,
       count(*) FILTER (WHERE s.is_speeding) AS speeding_samples,
       count(*) FILTER (WHERE s.starts_event) AS events
FROM public.trip_sample_scoring s WHERE s.trip_id = '<new-trip-id>'
GROUP BY s.status, s.used_fallback;

SELECT d.recorded_at, d.speed_kmh, l.speed_limit_kmh, l.provider, l.fetched_at,
       s.speed_limit_kmh_used, s.tolerance_kmh_used, s.threshold_kmh,
       s.used_fallback, s.is_speeding, s.starts_event
FROM public.trip_sample_scoring s
JOIN public.trip_data_points d USING (sample_id, trip_id)
LEFT JOIN public.trip_sample_speed_limits l USING (sample_id, trip_id)
WHERE s.trip_id = '<new-trip-id>' AND s.status = 'used'
ORDER BY d.recorded_at, d.sample_id;
```

Compare the snapshot event count with `starts_event` count and the score against
the stored exact distance/penalty. A duplicate/ignored row is not an event. Retry
end-trip and compare old completed trip scores; neither should change.
