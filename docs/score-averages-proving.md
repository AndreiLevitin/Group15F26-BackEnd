# Score averages proving test — AB#95

## Environment

Originally executed locally using PGlite with the averages migrations then numbered 007–008 (now 009–010), following migrations 001–006.
Supabase account tables, roles and identity were represented by local test fixtures.
No live Supabase database, HTTP endpoint, physical device or external provider was used.

## Procedure and observed results

The test uses one temporary driver and synthetic scoring payloads passed through
the real `save_trip_band_scoring_result` SQL storage function.
It reads the stored average rows directly after each step.

| Step | Average in all six periods | Included trips |
| --- | --- | --- |
| First score of 80 saved | 80.00 | 1 |
| Second score of 0 saved | 40.00 | 2 |
| Second trip excluded | 80.00 | 1 |
| Third score save encounters forced recalculation failure | 80.00 | 1 |
| Third score save retried successfully | 40.00 | 2 |

All six periods were checked: day, week, month, year, last 30 days and all time.

Exclusion preserved the trip's original stored score.
A temporary trigger forced an error during average writes.
The test compared complete stored average rows before and after that failure:
values, counts, identifiers and calculation timestamps remained unchanged.
The failed scoring transaction left the third trip Processing without a score
and did not retain partial scoring audit rows.
Removing the temporary failure trigger allowed the same scoring payload to succeed.

## Repeat

Run `tests/score-averages-proving.sql` as owner in a disposable test database
after migrations 001–010, with stop-on-error enabled.
The script returns the results table and rolls back all test data and objects.

The local runner also passed:
- score-averages.sql
- current-score-averages.sql
- band-scoring.sql
- trip-ownership-rls.sql

## Scope

This proves database storage, automatic recomputation and transaction rollback.
It does not prove GPS score calculation or live Home screen integration.
