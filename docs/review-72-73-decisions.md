# Review follow-up — Tasks 72 and 73

Implemented locally on `feature/73-score-stored-speed-limits`. Scripts 004/005
contain the final development schema, consolidated at the user's request.
Existing databases need a targeted update and a new Preview deployment.
No remote schema/config/deployment was changed by the agent.

## Responsibility boundaries

- **`api/end-trip.ts`** validates HTTP input and maps application outcomes to HTTP.
- **`complete-trip.ts`** owns the lifecycle use case: transition, configuration,
  enrichment, scoring, concurrent completion and error classification. Explicit
  dependency interfaces replace types inferred from concrete repositories.
- **`trip-completion-dependencies.ts`** is the composition root. This is where the
  concrete provider/storage implementation is selected.
- **Provider adapter** owns TomTom transport, normalization, limits and request
  budget. Generic chunking accepts its limits as parameters and contains no
  TomTom-specific maximums.
- **`gps-validation.ts`** owns shared coordinate/timestamp validity rules for
  enrichment, distance and scoring. Raw invalid readings are preserved.
- **`calculateTripScore` in TypeScript** is the authoritative implementation of
  threshold selection, fallback, representative readings, event boundaries and
  the score formula. These policies are tested there, not reimplemented in SQL.
- **PostgreSQL** owns atomic storage, sample/trip identity, required/nullable
  fields, structural audit consistency and completed-trip immutability.

Script 005 defines the scoring RPC without independent SQL threshold
selection and `lag()` event detection. Existing CHECK constraints still enforce
valid audit structure (e.g. threshold = applied limit + applied tolerance), and
stored event counts must agree with audit markers. The server-only RPC is trusted
to receive the domain result; direct writes by a service-role operator are not
independently rescored in the database. Since this project is still in development,
004/005 are maintained as the final initial schema, not an immutable migration history.

## Invalid readings

Invalid coordinates/timestamps are classified before calling a provider. They
get a lookup status `invalid_sample` with a null limit, are retained for audit,
and are ignored by scoring rather than fallback-scored. For this status the
timestamp records classification time; no road lookup was made for that sample.
A trace with some invalid readings can still be scored using its valid readings.
If none remain, the existing sufficiency rules produce Unscored.

Script 004 includes the new lookup status. An existing database's status constraint
must be updated before deploying the new code. Raw samples are not changed.

## Why retain eight API calls?

The frontend has `GPS_INTERVAL_MS=1000`, passed to Expo's location watch. This is
a requested sampling interval, not a guarantee of exactly one callback each second.
At one point/second, 40,000 points represent about **11h 6m 40s**. With overlap,
eight 4,900-point chunks cover at most **39,193 distinct points**, about **10h 53m
13s** at that rate. Distance splits, GPS gaps and subdivision can require more
calls for shorter recordings; this is not a guaranteed duration allowance.

Decision: keep the default and hard maximum of **8 calls per attempt** for this
PoC, including subdivision. It bounds recursive splitting and quota consumption.
Unbounded processing is intentionally not introduced.

The adapter preflights the initial chunks. If those already need more than the
budget, it fails with `request_limit` before making any HTTP call. Repeating that
input consumes no provider quota. The application returns HTTP 422 with
`retryable=false`. An adaptive split exhausting the budget also fails explicitly;
its earlier calls still count. Completed partial chunks are not persisted.

Future support for longer trips should persist chunk progress or use a durable
worker with a total budget; simply deleting the guard would be unsafe. Per-attempt
budgets do not replace monitoring of monthly/account quota or client retries.

## Errors and logs

Provider errors preserve only safe categories, HTTP status and a retryability
flag. Authentication failures and invalid/oversized input are not retryable;
quota, timeout and transient request failures are retryable. This flag does not
start an automatic retry loop.

The composition root writes structured JSON through `console.error` for runtime
logs: event, request ID, trip ID, stage, code, retryable, optional HTTP status and
timestamp. Error objects, keys, URLs, provider response bodies and GPS payloads
are excluded using an explicit field allowlist. A log-write failure does not
change a business result.

Decision: use the deployment's runtime logs for technical diagnostics. Keep the
existing scoring tables for persistent business audit. Do not add a Supabase
technical-log table to this PoC: it would couple diagnostics to the same database
that may be failing, and introduce retention/access management. If durable
cross-deployment diagnostics become necessary, add a logging sink behind the
injected logger; do not put log inserts in scoring/provider code.

## Validation and rollout

- Unit/use-case tests cover invalid samples, all-invalid traces, preflight with
  40,000 points, repeated oversized attempts with zero provider calls, safe error
  categories, full completion with filtering/enrichment/scoring, concurrent
  completion, old scores, logger failure and field filtering.
- Existing threshold/fallback/duplicate/formula tests remain authoritative.
- For a fresh database, apply 001 through the updated 005 in order.
- For an existing database created using the earlier 004/005, do not rerun
  CREATE TABLE statements. Update the status constraint with the SQL below, then
  execute only the `CREATE OR REPLACE FUNCTION public.save_trip_scoring_result`
  definition from the current 005 script. Existing function permissions remain.
  Both statements can be wrapped in one BEGIN/COMMIT transaction.
- Run the updated `tests/per-limit-scoring.sql`.
  The SQL test rolls back its rows and includes invalid-GPS enrichment/exclusion.
  The agent did not execute it against PostgreSQL.
- Redeploy Preview and rerun the existing verification script with its NEW URL.
  The previously verified 622-sample trip should retain the same result; existing
  completed trip scores and audit rows are not rewritten.

```sql
ALTER TABLE public.trip_sample_speed_limits
    DROP CONSTRAINT trip_sample_speed_limits_lookup_status_check;
ALTER TABLE public.trip_sample_speed_limits
    ADD CONSTRAINT trip_sample_speed_limits_lookup_status_check
    CHECK (lookup_status IN ('available','missing','unmatched','insufficient_trace','invalid_sample'));
-- Next: the CREATE OR REPLACE FUNCTION definition from database/005_per_limit_scoring.sql.
```
