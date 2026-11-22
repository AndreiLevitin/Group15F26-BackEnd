# Generated trip scoring checks

From the backend directory, using Node 24:

```sh
node scripts/test-trip-scores.mjs
node scripts/test-trip-scores.mjs trip-test-report.json
```

Creates synthetic GPS traces in memory and calls the real production distance
and scoring functions. Uses agreed default settings, not shell env overrides.
Prints expected/actual scores, distance, evaluated time and unscored reason.
Returns a nonzero exit code on any mismatch. Optional JSON contains every input
point and the complete scoring audit for inspection.

Scenarios are in `scripts/trip-test-cases.mjs`: compliant driving, constant
excess of 10/20/35/50 km/h, mixed categories, unknown limits, too few points,
short distance, and GPS gaps. Expected scores are independent fixed assertions.
Coordinates follow a synthetic straight line and do not represent a real road.

This is offline scoring verification: no trips are inserted into the database,
no API/provider requests are made, and no credentials are needed. The existing
`verify-speed-limit-preview.mjs` separately tests the live upload/end-trip flow
with real provider results; it cannot promise synthetic category scores.
