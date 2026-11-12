# Trip result API — AB#56

`GET /api/trip-result?tripId=<uuid>` reads the persisted result from `trips`.
Responses use `Cache-Control: no-store` so clients can poll while processing.

```json
{"tripId":"123e4567-e89b-42d3-a456-426614174000","status":"Completed","score":87,
  "reason":null,"startTime":"2026-11-09T14:00:00.000Z","endTime":"2026-11-09T14:30:00.000Z",
  "distanceKm":12.5,"durationSeconds":1800}
```

Statuses: `Active`, `Processing`, `Completed`, `Invalid`. Only `Completed`
exposes the stored score; zero is a valid score. An absent score stays null.
`Completed` with a null score returns `reason: "unscored"`; otherwise reason
is null. Clients stop polling on `Completed` (including unscored) or `Invalid`.
This endpoint does not calculate scores or change trip state. The response also
includes startTime and endTime (the stored trip times), distanceKm, and
durationSeconds, which is computed from the two times and is null while the
trip has not ended.

Errors: missing, malformed or repeated `tripId` → 400; unknown trip → 404;
database failure → 503. Error bodies contain an `error` code.

## Manual integration check

1. Start and end a test trip through the existing endpoints. Keep its UUID.
2. Request its result: expect `Processing` with `score: null`.
3. In Supabase SQL Editor, replace the placeholder with that test trip UUID:

```sql
UPDATE public.trips
SET status = 'Completed', trip_score = 87
WHERE trip_id = '<test-trip-uuid>' AND status = 'Processing';
```

4. Request the result again: expect `Completed` with `score: 87`.
5. Repeat the request after restarting the client; the result must remain available.

The SQL is a manual test fixture, not production scoring behavior.

## Local checks

```sh
node --experimental-strip-types --test tests/trip-result.test.ts
node node_modules/typescript/bin/tsc --noEmit
```
