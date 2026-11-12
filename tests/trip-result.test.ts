import assert from 'node:assert/strict';
import test from 'node:test';
import { createTripResultHandler } from '../src/services/trip-result.ts';
import type { TripStatus } from '../src/types/trip.ts';

const tripId = '123e4567-e89b-42d3-a456-426614174000';
const request = (query = `tripId=${tripId}`) => new Request(`https://example.test/api/trip-result?${query}`);

test('rejects missing, malformed and repeated IDs before accessing storage', async () => {
    const handler = createTripResultHandler(async () => {
        assert.fail('Storage should not be accessed');
    });
    for (const query of ['', 'tripId=bad', `tripId=${tripId}&tripId=${tripId}`]) {
        assert.equal((await handler(request(query))).status, 400);
    }
});

test('returns 404 for an unknown trip', async () => {
    const handler = createTripResultHandler(async () => null);
    assert.equal((await handler(request())).status, 404);
});

for (const status of ['Active', 'Processing', 'Invalid'] satisfies TripStatus[]) {
    test(`${status} does not expose a numeric score`, async () => {

        const handler = createTripResultHandler(async id => ({ trip_id: id, start_time: '2026-11-09T14:00:00.000Z', end_time: null, status, distance_km: null, trip_score: 87 }));
        const response = await handler(request());
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');

        assert.deepEqual(await response.json(), { tripId, status, score: null, reason: null, startTime: '2026-11-09T14:00:00.000Z', endTime: null, distanceKm: null, durationSeconds: null });
    });
}

test('returns stored completed scores including zero on repeated requests', async () => {
    for (const score of [0, 87, 100, null]) {
        const handler = createTripResultHandler(async id => ({ trip_id: id, start_time: '2026-11-09T14:00:00.000Z', end_time: '2026-11-09T14:30:00.000Z', status: 'Completed', distance_km: 12.5, trip_score: score }));
        for (let attempt = 0; attempt < 2; attempt++) {
            assert.deepEqual(await (await handler(request())).json(), {
                tripId, status: 'Completed', score,
                reason: score === null ? 'unscored' : null,

                startTime: '2026-11-09T14:00:00.000Z', endTime: '2026-11-09T14:30:00.000Z',
                distanceKm: 12.5, durationSeconds: 1800,
            });
        }
    }
});

test('returns 503 without leaking storage error details', async () => {
    const original = console.error;
    console.error = () => {};
    try {
        const handler = createTripResultHandler(async () => { throw new Error('private storage details'); });
        const response = await handler(request());
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'trip_lookup_failed' });
    } finally {
        console.error = original;
    }
});


test('returns the trip detail fields with the computed duration', async () => {
    const handler = createTripResultHandler(async id => ({
        trip_id: id,
        start_time: '2026-11-09T09:15:00.000Z',
        end_time: '2026-11-09T09:45:30.000Z',
        status: 'Completed',
        distance_km: 8.75,
        trip_score: 92,
    }));
    const response = await handler(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        tripId, status: 'Completed', score: 92, reason: null,
        startTime: '2026-11-09T09:15:00.000Z',
        endTime: '2026-11-09T09:45:30.000Z',
        distanceKm: 8.75,
        durationSeconds: 1830,
    });
});
