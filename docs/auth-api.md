# Auth API — AB#75

The mobile app creates accounts and signs in through these endpoints. It never
talks to Supabase directly. The backend calls Supabase Auth with the secret key.

## Decisions

- **Email confirmation is off.** Accounts are created already confirmed
  (`admin.createUser` with `email_confirm: true`), so sign-up returns a session
  and the user goes straight into the app. No emails are sent.
  - Demo consequence: no inbox and no email rate limits are involved, and a
    mistyped or fake email is still accepted.
  - Because the admin API is used, this behaviour does not depend on the
    dashboard's "Confirm email" setting. Turn it off there as well so the
    project settings tell the same story.
- **Passwords must be at least 8 characters.** The backend enforces this on
  sign-up. Also set Authentication → Providers → Email → *Minimum password
  length* to 8 in the Supabase dashboard so it holds for any other path.
- **Duplicate email → `409 email_already_registered`.**

## Endpoints

Both take `Content-Type: application/json` with `{ "email": string, "password": string }`.
The email is trimmed. Responses use `Cache-Control: no-store`.

### `POST /api/sign-up` → `201`
### `POST /api/sign-in` → `200`

```json
{
  "user": { "id": "<uuid>", "email": "driver@example.com" },
  "session": {
    "accessToken": "<jwt>",
    "refreshToken": "<token>",
    "expiresAt": 1900000000
  }
}
```

`expiresAt` is Unix time in **seconds**.

### Errors

Every error body is `{ "error": "<code>", "message": "<text safe to show the user>" }`.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | Body is not JSON, or email/password missing or not strings |
| 400 | `invalid_email` | Email is not a valid address |
| 400 | `password_too_short` | Sign-up only: password under 8 characters |
| 400 | `weak_password` | Supabase rejected the password for another reason |
| 409 | `email_already_registered` | Sign-up only: an account already uses that email |
| 401 | `invalid_credentials` | Sign-in only: wrong email or password |
| 429 | `rate_limited` | Supabase rate limit hit |
| 503 | `auth_unavailable` | Any unexpected Supabase or server failure |

Sign-in does not apply the length rule, so a wrong password always gets the
same `invalid_credentials` answer.

## `POST /api/refresh-session` → `200` (AB#77)

Body: `{ "refreshToken": string }`. Returns the same `{ user, session }` shape
as sign-in, with a new access token **and a new refresh token** — the old
refresh token is used up, so the client must store the new one.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | `refreshToken` missing or not a non-empty string |
| 401 | `invalid_refresh_token` | Token used, revoked or unknown; the user must sign in again |
| 429 | `rate_limited` | Supabase rate limit hit |
| 503 | `auth_unavailable` | Unexpected Supabase or server failure |

## `POST /api/sign-out` → `204` (Bug 89)

Header: `Authorization: Bearer <accessToken>`. No body. Revokes the session
that access token belongs to: afterwards that access token is rejected by
every trip endpoint (`401`) and its refresh token can no longer be refreshed.
Only this session ends; the account's other devices stay signed in.

| Status | `error` | When |
| --- | --- | --- |
| 204 | — | Session ended, or it had already ended (safe to repeat) |
| 401 | `unauthorized` | No or malformed `Authorization` header |
| 429 | `rate_limited` | Supabase rate limit; the session may still be live |
| 503 | `auth_unavailable` | Supabase Auth unreachable; the session may still be live |

The app calls this before clearing its tokens. If it fails, the app still
signs out locally, so a user is never stuck signed in.

## Using the session

Trip endpoints require `Authorization: Bearer <accessToken>`; see
`docs/trip-ownership.md`.

## Local checks

```sh
node --experimental-strip-types --test tests/auth.test.ts
node node_modules/typescript/bin/tsc --noEmit
```
