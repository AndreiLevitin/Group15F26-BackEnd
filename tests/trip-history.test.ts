import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTripHistory } from '../src/services/trip-history.ts';
import type { Trip } from '../src/types/trip.ts';

function makeTrip(overrides: Partial<Trip> = {}): Trip {
    return {
        trip_id: 'trip-1',
        start_time: '2026-11-13T10:00:00Z',
        end_time: '2026-11-13T10:05:00Z',
        status: 'Completed',
        distance_km: 2,
        trip_score: 90,
        ...overrides,
    };
}

test('no trips returns an empty list', () => {
    assert.deepEqual(buildTripHistory([]), []);
});

test('newest trips come first without changing the original list', () => {
    const older = makeTrip({ trip_id: 'older' });
    const newer = makeTrip({
        trip_id: 'newer',
        start_time: '2026-11-13T11:00:00Z',
        end_time: '2026-11-13T11:05:00Z',
    });
    const trips = [older, newer];

    assert.deepEqual(
        buildTripHistory(trips).map(trip => trip.tripId),
        ['newer', 'older'],
    );
    assert.deepEqual(trips, [older, newer]);
});

test('returns the stored score, dates, distance and duration in seconds', () => {
    assert.deepEqual(buildTripHistory([makeTrip()])[0], {
        tripId: 'trip-1',
        startTime: '2026-11-13T10:00:00Z',
        endTime: '2026-11-13T10:05:00Z',
        durationSeconds: 300,
        distanceKm: 2,
        status: 'Completed',
        score: 90,
        reason: null,
    });
});

test('a real zero score stays zero', () => {
    const [trip] = buildTripHistory([makeTrip({ trip_score: 0 })]);
    assert.equal(trip?.score, 0);
    assert.equal(trip?.reason, null);
});

test('processing trips hide any score until completed', () => {
    const [trip] = buildTripHistory([
        makeTrip({ status: 'Processing', trip_score: 90 }),
    ]);
    assert.equal(trip?.status, 'Processing');
    assert.equal(trip?.score, null);
    assert.equal(trip?.reason, null);
});

test('completed trips without a score are unscored', () => {
    const [trip] = buildTripHistory([makeTrip({ trip_score: null })]);
    assert.equal(trip?.score, null);
    assert.equal(trip?.reason, 'unscored');
});

test('a trip without an end time has no duration', () => {
    const [trip] = buildTripHistory([
        makeTrip({ status: 'Active', end_time: null, trip_score: null }),
    ]);
    assert.equal(trip?.durationSeconds, null);
});

test('invalid or reversed times do not produce an invalid duration', () => {
    for (const end_time of ['invalid', '2026-11-13T09:00:00Z']) {
        const [trip] = buildTripHistory([makeTrip({ end_time })]);
        assert.equal(trip?.durationSeconds, null);
    }
});
