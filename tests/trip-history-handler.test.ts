import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticator } from '../src/services/request-auth.ts';
import { createTripHistoryHandler } from '../src/services/trip-history-handler.ts';

function request(token?: string) {
    return new Request('https://example.com/api/trip-history?userId=someone-else', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
}

test('missing or invalid token never queries trips', async () => {
    let calls = 0;
    const handler = createTripHistoryHandler(
        async () => { calls++; return []; },
        createAuthenticator(async () => null),
    );
    for (const token of [undefined, 'invalid']) {
        const response = await handler(request(token));
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(calls, 0);
});

test('uses verified identity and ignores a user ID in the URL', async () => {
    const handler = createTripHistoryHandler(
        async (access) => {
            assert.deepEqual(access, {
                userId: 'verified-owner',
                accessToken: 'valid-token',
            });
            return [];
        },
        createAuthenticator(async token => {
            assert.equal(token, 'valid-token');
            return { id: 'verified-owner' };
        }),
    );
    const response = await handler(request('valid-token'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { trips: [] });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('database failure returns 503 instead of an empty history', async () => {
    const handler = createTripHistoryHandler(
        async () => { throw new Error('database failure'); },
        createAuthenticator(async () => ({ id: 'verified-owner' })),
    );
    const response = await handler(request('valid-token'));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
        error: 'trip_history_unavailable',
    });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
