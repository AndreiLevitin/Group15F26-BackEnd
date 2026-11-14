// AB#77: trips belong to the signed-in account; identity comes only from a
// verified access token.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthenticator, type Authenticate } from '../src/services/request-auth.ts';
import { createStartTripHandler } from '../src/services/start-trip.ts';
import { createUploadTripSamplesHandler } from '../src/services/upload-trip-samples.ts';
import { createEndTripHandler } from '../src/services/end-trip.ts';
import { createRefreshSessionHandler } from '../src/services/auth.ts';
import type { TripSampleRow, UserTripRepository } from '../src/repositories/user-trip-repository.ts';
import type { AuthResult, TripAccess } from '../src/types/auth.ts';
import { AuthRateLimitedError } from '../src/types/auth-errors.ts';
import type { Trip } from '../src/types/trip.ts';

const tripId = '123e4567-e89b-42d3-a456-426614174000';
const userA: TripAccess = { userId: 'user-a', accessToken: 'token-a' };
const activeTrip: Trip = {
    trip_id: tripId, start_time: '2026-11-13T10:00:00.000Z', end_time: null,
    status: 'Active', distance_km: null, trip_score: null,
};
const sample = { timestamp: '2026-11-13T10:00:01.000Z', speed: 50, acceleration: 0.1, latitude: 43, longitude: -80 };

const post = (path: string, body?: unknown, token?: string) => new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const asUserA: Authenticate = async () => ({ ok: true, access: userA });
const denied: Authenticate = async () => ({
    ok: false, response: Response.json({ error: 'unauthorized' }, { status: 401 }),
});

function quietly<T>(run: () => Promise<T>): Promise<T> {
    const original = console.error;
    console.error = () => {};
    return run().finally(() => { console.error = original; });
}

// --- Token verification ----------------------------------------------------

test('missing, malformed or non-Bearer Authorization headers are 401 without calling Auth', async () => {
    const authenticate = createAuthenticator(async () => assert.fail('Auth should not be called'));
    for (const header of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'bearer token-a', 'Bearer a b']) {
        const request = new Request('https://example.test/api/start-trip', {
            method: 'POST', headers: header === undefined ? {} : { Authorization: header },
        });
        const result = await authenticate(request);
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.response.status, 401);
            assert.equal(result.response.headers.get('WWW-Authenticate'), 'Bearer');
            assert.equal((await result.response.json()).error, 'unauthorized');
        }
    }
});

test('an invalid or expired token is 401', async () => {
    const result = await createAuthenticator(async () => null)(post('/x', undefined, 'expired'));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 401);
});

test('the user ID comes from the verified token only', async () => {
    let verified: string | undefined;
    const authenticate = createAuthenticator(async token => { verified = token; return { id: 'user-a' }; });
    const result = await authenticate(post('/x', { userId: 'user-b' }, 'token-a'));
    assert.equal(verified, 'token-a');
    assert.deepEqual(result, { ok: true, access: { userId: 'user-a', accessToken: 'token-a' } });
});

test('an Auth rate limit is 429 with Retry-After, not 401, so the client does not refresh or sign out', async () => {
    const result = await createAuthenticator(async () => { throw new AuthRateLimitedError(); })(
        post('/x', undefined, 'token-a'));
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.response.status, 429);
        assert.equal(result.response.headers.get('Retry-After'), '5');
        assert.equal((await result.response.json()).error, 'rate_limited');
    }
});

test('a rate-limited refresh is 429, not invalid_refresh_token', async () => {
    const handler = createRefreshSessionHandler(async () => ({ ok: false, reason: 'rate_limited' }));
    const response = await handler(post('/api/refresh-session', { refreshToken: 'refresh-1' }));
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error, 'rate_limited');
});

test('Auth being unreachable is 503, not 401', async () => {
    const result = await quietly(() =>
        createAuthenticator(async () => { throw new Error('network'); })(post('/x', undefined, 'token-a')));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 503);
});

// --- Every trip endpoint requires a session --------------------------------

const untouched: UserTripRepository = {
    findActiveTrip: async () => assert.fail('storage should not be accessed'),
    createActiveTrip: async () => assert.fail('storage should not be accessed'),
    findTrip: async () => assert.fail('storage should not be accessed'),
    replaceSamples: async () => assert.fail('storage should not be accessed'),
};

test('start, upload and end all reject an unauthenticated request before touching storage', async () => {
    const handlers = [
        createStartTripHandler(denied, untouched)(post('/api/start-trip')),
        createUploadTripSamplesHandler(denied, untouched)(post('/api/upload-trip-samples', { tripId, samples: [sample] })),
        createEndTripHandler(denied, untouched, async () => assert.fail('scoring should not run'))(post('/api/end-trip', { tripId })),
    ];
    for (const response of await Promise.all(handlers)) assert.equal(response.status, 401);
});

// --- Start ------------------------------------------------------------------

test('start creates the trip for the caller and ignores any userId in the body', async () => {
    const created: TripAccess[] = [];
    const handler = createStartTripHandler(asUserA, {
        findActiveTrip: async () => null,
        createActiveTrip: async caller => { created.push(caller); return activeTrip; },
    });
    const response = await handler(post('/api/start-trip', { userId: 'user-b' }));
    assert.equal(response.status, 201);
    assert.deepEqual(created, [userA]);
});

test('start returns the caller\'s existing active trip as 409', async () => {
    const handler = createStartTripHandler(asUserA, {
        findActiveTrip: async () => activeTrip,
        createActiveTrip: async () => assert.fail('must not create a second active trip'),
    });
    const response = await handler(post('/api/start-trip'));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).trip.trip_id, tripId);
});

test('start resolves a concurrent-start race to the winning active trip', async () => {
    let lookups = 0;
    const handler = createStartTripHandler(asUserA, {
        findActiveTrip: async () => (lookups++ === 0 ? null : activeTrip),
        createActiveTrip: async () => null,
    });
    assert.equal((await handler(post('/api/start-trip'))).status, 409);
});

// --- Upload -----------------------------------------------------------------

test('upload to another account\'s trip is 404 and stores nothing', async () => {
    const handler = createUploadTripSamplesHandler(asUserA, {
        findTrip: async () => null,
        replaceSamples: async () => assert.fail('must not store samples'),
    });
    const response = await handler(post('/api/upload-trip-samples', { tripId, samples: [sample] }));
    assert.equal(response.status, 404);
});

test('upload stores mapped rows as the caller', async () => {
    const stored: { caller: TripAccess; rows: TripSampleRow[] }[] = [];
    const handler = createUploadTripSamplesHandler(asUserA, {
        findTrip: async () => activeTrip,
        replaceSamples: async (caller, _id, rows) => { stored.push({ caller, rows }); },
    });
    const response = await handler(post('/api/upload-trip-samples', { tripId, samples: [sample] }));
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { trip_id: tripId, inserted: 1 });
    assert.deepEqual(stored, [{ caller: userA, rows: [{
        trip_id: tripId, recorded_at: sample.timestamp, speed_kmh: 50,
        acceleration: 0.1, latitude: 43, longitude: -80,
    }] }]);
});

test('upload keeps the existing validation and ended-trip rules', async () => {
    const handler = createUploadTripSamplesHandler(asUserA, {
        findTrip: async () => ({ ...activeTrip, status: 'Processing' }),
        replaceSamples: async () => assert.fail('must not store samples'),
    });
    assert.equal((await handler(post('/api/upload-trip-samples', { tripId: 'bad', samples: [sample] }))).status, 400);
    assert.equal((await handler(post('/api/upload-trip-samples', { tripId, samples: [] }))).status, 400);
    assert.equal((await handler(post('/api/upload-trip-samples', { tripId, samples: [sample] }))).status, 409);
});

// --- End --------------------------------------------------------------------

test('end refuses another account\'s trip without running scoring', async () => {
    const handler = createEndTripHandler(asUserA, { findTrip: async () => null },
        async () => assert.fail('scoring must not run for a trip the caller does not own'));
    assert.equal((await handler(post('/api/end-trip', { tripId }))).status, 404);
});

test('end runs scoring for the caller\'s own trip', async () => {
    const completed: string[] = [];
    const handler = createEndTripHandler(asUserA, { findTrip: async () => activeTrip }, async id => {
        completed.push(id);
        return { kind: 'Completed', trip: { ...activeTrip, status: 'Completed', trip_score: 90 } };
    });
    const response = await handler(post('/api/end-trip', { tripId }));
    assert.equal(response.status, 200);
    assert.deepEqual(completed, [tripId]);
});

// --- Refresh ----------------------------------------------------------------

const session = (token: string): AuthResult => ({
    ok: true,
    auth: {
        user: { id: 'user-a', email: 'a@example.com' },
        session: { accessToken: token, refreshToken: 'refresh-2', expiresAt: 1_900_000_000 },
    },
});

test('refresh exchanges a refresh token for a new session', async () => {
    const handler = createRefreshSessionHandler(async token => {
        assert.equal(token, 'refresh-1');
        return session('access-2');
    });
    const response = await handler(post('/api/refresh-session', { refreshToken: 'refresh-1' }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).session.accessToken, 'access-2');
});

test('refresh rejects a missing body field and an unusable token', async () => {
    const neverCalled = createRefreshSessionHandler(async () => assert.fail('Auth should not be called'));
    for (const body of [undefined, {}, { refreshToken: '' }, { refreshToken: 5 }]) {
        assert.equal((await neverCalled(post('/api/refresh-session', body))).status, 400);
    }
    const revoked = createRefreshSessionHandler(async () => ({ ok: false, reason: 'invalid_refresh_token' }));
    const response = await revoked(post('/api/refresh-session', { refreshToken: 'used' }));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'invalid_refresh_token');
});
