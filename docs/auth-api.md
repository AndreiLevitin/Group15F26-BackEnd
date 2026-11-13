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

## Not covered yet

- Token refresh. Access tokens expire after Supabase's JWT expiry (1 hour by
  default). Nothing uses the token yet, so this is left for the task that
  starts requiring auth on the trip endpoints.
- Trips are not linked to users, and the trip endpoints do not check tokens.

## Local checks

```sh
node --experimental-strip-types --test tests/auth.test.ts
node node_modules/typescript/bin/tsc --noEmit
```
