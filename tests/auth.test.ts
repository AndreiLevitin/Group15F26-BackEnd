import assert from 'node:assert/strict';
import test from 'node:test';
import { createSignInHandler, createSignUpHandler } from '../src/services/auth.ts';
import type { AuthCredentials, AuthResult } from '../src/types/auth.ts';

const request = (body: unknown) => new Request('https://example.test/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
});

const success = (email: string): AuthResult => ({
    ok: true,
    auth: {
        user: { id: '123e4567-e89b-42d3-a456-426614174000', email },
        session: { accessToken: 'access', refreshToken: 'refresh', expiresAt: 1_900_000_000 },
    },
});

const neverCalled = async (): Promise<AuthResult> => assert.fail('Supabase should not be called');

for (const [name, create] of [
    ['sign-up', createSignUpHandler],
    ['sign-in', createSignInHandler],
] as const) {
    test(`${name} rejects malformed bodies before calling Supabase`, async () => {
        const handler = create(neverCalled);
        for (const body of ['not json', null, [], {}, { email: 'a@b.co' }, { email: 1, password: 'password1' }, { email: '  ', password: 'password1' }]) {
            const response = await handler(request(body));
            assert.equal(response.status, 400);
            assert.equal((await response.json()).error, 'invalid_request');
        }
    });

    test(`${name} rejects an invalid email address`, async () => {
        const response = await create(neverCalled)(request({ email: 'not-an-email', password: 'password1' }));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, 'invalid_email');
    });

    test(`${name} returns 503 without leaking Supabase details`, async () => {
        const original = console.error;
        console.error = () => {};
        try {
            const handler = create(async () => { throw new Error('private details'); });
            const response = await handler(request({ email: 'a@b.co', password: 'password1' }));
            assert.equal(response.status, 503);
            const body = await response.json();
            assert.equal(body.error, 'auth_unavailable');
            assert.doesNotMatch(JSON.stringify(body), /private details/);
        } finally {
            console.error = original;
        }
    });
}

test('sign-up enforces the 8-character minimum before calling Supabase', async () => {
    const response = await createSignUpHandler(neverCalled)(request({ email: 'a@b.co', password: '1234567' }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
        error: 'password_too_short',
        message: 'Password must be at least 8 characters.',
    });
});

test('sign-up accepts exactly 8 characters, trims the email and returns 201 with a session', async () => {
    let received: AuthCredentials | undefined;
    const handler = createSignUpHandler(async credentials => {
        received = credentials;
        return success(credentials.email);
    });
    const response = await handler(request({ email: '  new@example.com ', password: '12345678' }));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(received, { email: 'new@example.com', password: '12345678' });
    const expected = success('new@example.com');
    assert.ok(expected.ok);
    assert.deepEqual(await response.json(), expected.auth);
});

test('sign-up reports a duplicate email as 409', async () => {
    const handler = createSignUpHandler(async () => ({ ok: false, reason: 'email_already_registered' }));
    const response = await handler(request({ email: 'taken@example.com', password: 'password1' }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'email_already_registered');
});

test('sign-in does not apply the new-password length rule', async () => {
    const handler = createSignInHandler(async () => ({ ok: false, reason: 'invalid_credentials' }));
    const response = await handler(request({ email: 'a@b.co', password: 'short' }));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'invalid_credentials');
});

test('sign-in returns 200 with the session', async () => {
    const response = await createSignInHandler(async c => success(c.email))(
        request({ email: 'user@example.com', password: 'password1' }),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).session.accessToken, 'access');
});

test('rate limiting from Supabase is reported as 429', async () => {
    const handler = createSignInHandler(async () => ({ ok: false, reason: 'rate_limited' }));
    const response = await handler(request({ email: 'a@b.co', password: 'password1' }));
    assert.equal(response.status, 429);
});
