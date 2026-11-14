// Bug 89: signing out must end the session on the backend, not only on the phone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSignOutHandler } from '../src/services/sign-out.ts';
import { AuthRateLimitedError } from '../src/types/auth-errors.ts';

const post = (authorization?: string) => new Request('https://example.test/api/sign-out', {
    method: 'POST',
    headers: authorization === undefined ? {} : { Authorization: authorization },
});

function quietly<T>(run: () => Promise<T>): Promise<T> {
    const original = console.error;
    console.error = () => {};
    return run().finally(() => { console.error = original; });
}

test('revokes the session behind the caller\'s token and answers 204', async () => {
    const revoked: string[] = [];
    const response = await createSignOutHandler(async token => { revoked.push(token); })(post('Bearer token-a'));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(revoked, ['token-a']);
});

test('a missing or malformed Authorization header is 401 without calling Auth', async () => {
    const handler = createSignOutHandler(async () => assert.fail('Auth should not be called'));
    for (const header of [undefined, '', 'Bearer', 'Basic abc', 'bearer token-a']) {
        const response = await handler(post(header));
        assert.equal(response.status, 401);
        assert.equal((await response.json()).error, 'unauthorized');
    }
});

test('a rate limit is 429, so the client knows the session may still be live', async () => {
    const response = await createSignOutHandler(async () => { throw new AuthRateLimitedError(); })(post('Bearer token-a'));
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error, 'rate_limited');
});

test('an Auth outage is 503 without leaking details', async () => {
    const response = await quietly(() =>
        createSignOutHandler(async () => { throw new Error('private details'); })(post('Bearer token-a')));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, 'auth_unavailable');
    assert.doesNotMatch(JSON.stringify(body), /private details/);
});
