# Time-weighted speed bands - AB#73

The agreed revision of US #64 replaces event penalties and the 85 km/h fallback
for newly completed trips. Old completed trips and their audit rows are immutable.
Task #72 still enriches raw GPS from the database using the provider interface.
The frontend contract remains a number or null; detail screens/export are future work.

## Rules

Excess is actual speed minus the posted limit, in km/h. At or below tolerance,
score 100. Otherwise select the highest inclusive `fromKmh` band. Do not subtract
tolerance again before selecting the band. Ontario demerit categories inspired
the boundaries; these score values are our calibration, not an official rating.

| Excess above posted limit | Score |
| --- | ---: |
| At most 5 | 100 |
| More than 5, below 16 | 80 |
| 16 to below 30 | 60 |
| 30 to below 50 | 40 |
| 50 or more | 0 |

Validate GPS coordinates, timestamps and nonnegative device speeds; ignore
accelerometer-only rows. Deduplicate timestamps using the highest valid speed
and its own limit; equal-speed ties keep the lowest stable sample ID. Sort once,
then walk adjacent GPS pairs. Invalid timestamped GPS rows remain barriers.
Rows without a usable timestamp are ignored and counted; they cannot be placed
on the timeline. No synthetic intermediate GPS points are created.

For each positive interval, exclusions are checked in this order:
1. More than the configured maximum interval: `gps_gap`.
2. Invalid endpoint: `invalid_endpoint`.
3. Mean endpoint speed below the moving threshold: `stationary`.
4. Either endpoint has no limit: `unknown_limit`.

Accepted interval score = mean of its endpoint scores. Trip score = sum of
interval score times duration / evaluated duration. Endpoint averaging is an
explicit approximation for short intervals, not a reconstruction of actual speed
between samples. Round only the final result; a positive mean displays at least 1.
Only an entirely zero-rated evaluated trip displays 0.

Both distance and minimum sample count are inclusive gates. Count the minimum
samples among distinct endpoints of accepted intervals. No accepted intervals or
insufficient participating points yields Unscored. There is no separate minimum
time or coverage gate in this PoC. A low-coverage score can therefore exist;
coverage must accompany its audit. Minimum distance is the entire valid trip GPS
distance, not an invented distance from unknown speed limits.

Events remain available as diagnostics, but do not determine score. Consecutive
speeding participating samples form an event; rejected intervals break continuity.
There is no emergency-event penalty or city/highway adjustment in this model.

## Server configuration

The following agreed defaults are defined in server code. Environment variables
are optional overrides for newly ended trips:

| Variable | Agreed PoC value |
| --- | --- |
| `TRIP_MIN_VALID_READINGS` | `5` |
| `TRIP_MIN_DISTANCE_KM` | `0.1` |
| `TRIP_SPEED_TOLERANCE_KMH` | `5` |
| `TRIP_MAX_SCORING_INTERVAL_SECONDS` | `3` |
| `TRIP_MIN_MOVING_SPEED_KMH` | `5` |
| `TRIP_SPEED_SCORE_BANDS` | JSON below |

```json
[{"fromKmh":0,"score":80},{"fromKmh":16,"score":60},{"fromKmh":30,"score":40},{"fromKmh":50,"score":0}]
```

The first band starts at zero and applies only above tolerance. Boundaries must
increase, scores must be non-increasing within 0..100, and tolerance must remain
below the second boundary. The JSON table supports calibration without code
changes. Absent variables use the defaults; present but empty, malformed or out-of-range
values fail explicitly. Defaults and overrides both pass the same validation.
The effective config is saved with each trip, including when defaults are used.
An existing `TRIP_MIN_DISTANCE_KM=0.0001` still overrides the 0.1 km default;
remove that override or change it to `0.1` to use the agreed minimum.
`TRIP_SPEEDING_PENALTY_PER_EVENT` and `TRIP_FALLBACK_SPEED_THRESHOLD_KMH` are no
longer read by v2. They may remain configured for older deployment compatibility.
Keep `TRIP_SPEED_LIMIT_ENRICHMENT_ENABLED=true` and the server TomTom key.
Disabling enrichment without already stored limits produces exclusions/Unscored,
not a fallback score. Provider failures still fail processing rather than
masquerading as unknown limits.

## Database rollout and audit

For a fresh DB, apply `database/001...005` in order. Updated
`005_per_limit_scoring.sql` directly creates the current tables and both RPCs.

For the one existing development installation created using the previous 005,
run the separate one-time script
[`upgrade-band-scoring-existing-db.sql`](../../research/task-73/upgrade-band-scoring-existing-db.sql).
Do not re-run 004/005 CREATE TABLE statements there. The upgrade preserves the old
RPC so the currently deployed backend can finish trips during rollout. Deploy
the new backend after the update and environment configuration. No SQL update or
deployment was executed by the agent. There is no installation script 006.


New RPC `save_trip_band_scoring_result` atomically saves:
- `trip_scoring_results`: `road-bands-v2`, score, counts, exact distance,
  `scoring_config` snapshot and `quality`. Old fallback/penalty fields stay null.
- `trip_sample_scoring`: endpoint `reading_score`, status, limits and event flags
  for participating samples; unknown or isolated valid samples are `excluded`.
  Unscored trips retain eligible endpoint scores but have no `used` flags.
- `trip_interval_scoring`: endpoint IDs, duration, score or exclusion reason.

Quality includes evaluated readings/time, valid moving time, coverage percent,
unknown-limit/stationary/gap/invalid-endpoint durations and duration per score.
Coverage denominator is valid moving time in short intervals, including unknown
limits. Long gaps and stationary/invalid intervals are reported separately.
Exclusion durations are disjoint due to the priority order above. Category time
assigns half the interval duration to each endpoint category. Provider/fetch
provenance remains in `trip_sample_speed_limits`. Raw data is never rewritten.

SQL verifies identity, counts and structural constraints. TypeScript alone owns
the formula and interval eligibility. Completed trips return their original
result without changing score, timestamp, parameters or decisions.

## Verification

### Story 64 known-trip proof (AB#110)

Use Node 24 and run this from the backend repository:

```sh
npm run prove:speed-limit-scoring
```

This runs the real scoring service with 50 fixture GPS readings, a 500 m
route and fixed scoring parameters. It checks the GPS-derived distance,
participating reading count and score using in-memory repository substitutes.
The proof lives under `scripts/`. Run the command above alongside
`node --test tests/*.test.ts` to include it in local verification.

To verify actual persistence when a Supabase test database is available, apply
migrations 001–006 and set `TEST_SUPABASE_URL` and `TEST_SUPABASE_SECRET_KEY`
to the test project's API URL and secret or service-role key. Then run
`npm run prove:speed-limit-scoring:db`. This also runs the proof with the
real repositories. It uploads the fixture while the trip is Active, moves
the trip to Processing, seeds the posted limits and checks the saved score.
Cleanup removes the scoring audit and limits, reopens the fixture trip,
then deletes its GPS rows and the trip.

| Seconds within each block | Speed (km/h) | Limit (km/h) | Reading score |
| ---: | ---: | ---: | ---: |
| 0 | 55 | 50 | 100 |
| 1 | 60 | 50 | 80 |
| 3 | 60 | 60 | 100 |
| 4 | 76 | 60 | 60 |
| 6 | 90 | 60 | 40 |
| 7 | 110 | 60 | 0 |

Each interval score is the average of its two endpoint reading scores. For
example, the first interval averages 100 and 80 to get 90. Multiply each
interval score by its duration in seconds before summing. The six-point block
repeats eight times, starting every eight seconds. Each block contributes
`90 × 1 + 90 × 2 + 80 × 1 + 50 × 2 + 20 × 1 = 470`
score-seconds. The seven one-second intervals between blocks each contribute
50. The final two readings at seconds 64 and 67 both score 100, adding
`50 × 1 + 100 × 3`. The trip's weighted mean is
`(8 × 470 + 7 × 50 + 50 + 300) / 67 ≈ 66.57`, which rounds to **67**.
The identical 60 km/h readings receive different scores because their posted
limits differ.

```powershell
node --test tests/*.test.ts
node node_modules/typescript/bin/tsc --noEmit
node scripts/replay-band-scoring.mjs "<exported-trip.csv>" "<audit.json>"
```

The offline script uses `docs/scoring-config.example.json` unless an explicit
config file is passed as its third argument. It never calls APIs or writes the DB.
Original Nov 12 college trip: 1,223 GPS rows, one duplicate, 1,062 participating
readings, 1,050.022 evaluated seconds, 92.4977% valid-moving-time coverage.
Weighted mean 89.6279697, rounded score **90**, compared with historical 99.
This is an offline replay of stored limits, not a new provider/DB test.

Run `tests/band-scoring.sql` in the Supabase SQL Editor after the updated 005 (or the one-time upgrade). It rolls back
its test data and checks atomicity, exclusions, saved config, repeat immutability
and access restrictions. It is prepared but has not been executed by the agent.
The older `tests/per-limit-scoring.sql` covers the preserved v1 RPC only.

Use `scripts/verify-speed-limit-preview.mjs <new-preview-url>` for a live new-trip
API check, then inspect the printed SQL. Completed alone does not establish which
model ran or whether enrichment was enabled.

## Local verification record

After the band-scoring revision and optional env overrides: all **57** Node tests pass; TypeScript no-emit,
script syntax checks and `git diff --check` pass. Offline replay reproduces the
recorded-trip result above. Database migration/SQL tests and Preview verification
remain pending; no live DB, environment or deployment was changed by the agent.
