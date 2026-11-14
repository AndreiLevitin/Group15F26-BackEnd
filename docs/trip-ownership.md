# Trip ownership and access — AB#77

Every trip belongs to the account that started it. Only that account can
read it, upload samples to it, end it or see its result.

## How a request is authorised

1. **Token.** `start-trip`, `upload-trip-samples`, `end-trip` and
   `trip-result` require `Authorization: Bearer <accessToken>` (from sign-in,
   sign-up or refresh). The backend verifies it with Supabase Auth and takes
   the user ID from it. **A user ID in the URL or body is never used.**
   - Missing, malformed, expired or revoked token → `401 unauthorized`
     (`WWW-Authenticate: Bearer`). The client should refresh once and retry.
   - Supabase Auth rate-limiting the backend → `429 rate_limited` with
     `Retry-After`. This is temporary and says nothing about the token, so
     the client must **not** refresh or sign out because of it. Every Auth
     error rule checks for 429 before treating other 4xx answers as an
     invalid token or session (`src/repositories/auth-error-mapping.ts`).
   - Supabase Auth unreachable → `503 auth_unavailable`.
2. **Query filter.** Trip queries for the user filter on `user_id`.
3. **Row-level security (backstop).** Those queries run on a Supabase client
   carrying the user's token and the *publishable* key, so the database
   applies the policies in `database/006_trip_ownership.sql` even if a
   filter is missed. Scoring still runs with the secret key, but only after
   the ownership check in step 2–3 passes.

Another account's trip is always reported as `404 trip_not_found`, exactly
like a trip that does not exist, so trip IDs cannot be probed.

## What a signed-in user can do directly in the database

The same policies apply to anyone calling the Supabase API with a user token:

| Table | Allowed |
| --- | --- |
| `trips` | Read own rows. Insert own row with only `user_id` and `status = 'Active'`. No update or delete. |
| `trip_data_points` | Read own samples. Insert or delete samples only on an own **Active** trip. |
| Scoring and speed-limit tables | Nothing (unchanged from 004/005). |

Anonymous callers can do nothing on any trip table.

## Other changes

- **One active trip per account.** The old index allowed one Active trip in
  the whole system; it is now one per `user_id`.
- `guard_trip_samples()` now runs as its owner (`SECURITY DEFINER`) because
  it locks the trip row with `FOR SHARE`, which users have no privilege for.
- An account that owns trips cannot be deleted until its trips are removed
  or reassigned (`user_id` has no `ON DELETE` action).

## Pre-account trips — decision pending

Trips created before this change have `user_id = NULL`. They are **kept**,
hidden from every account by RLS, and still visible to the service role.
This is the reversible option; the team's decision is still to be recorded
on AB#77. Once it is:

```sql
-- Delete them (samples and scoring rows first if foreign keys require it):
DELETE FROM public.trips WHERE user_id IS NULL;
-- Or give them to one account:
UPDATE public.trips SET user_id = '<auth user uuid>' WHERE user_id IS NULL;
```

`scripts/import-course-test-trip.ts` still uses the secret key, so the
trips it creates are unowned and are not visible in the app.

## Deploying

1. Run `database/006_trip_ownership.sql` in the Supabase SQL editor.
2. Add **`SUPABASE_PUBLISHABLE_KEY`** to the backend environment (Vercel).
   It is the project's publishable (anon) key from *Project Settings → API
   Keys*. Without it, trip endpoints return 503.
3. Deploy the backend, then the app. The previous app version sends no token
   and gets `401` from trip endpoints.

## Checks

```sh
node --experimental-strip-types --test tests/*.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

`tests/trip-ownership-rls.sql` exercises the policies as two users and an
anonymous caller. Run it in a test project's SQL editor after 006; it rolls
back everything it creates.
