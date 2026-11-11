import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTripScoringConfig, scoreEndedTrip } from '../src/services/score-ended-trip.ts';
import type { RecordedTripResult } from '../src/repositories/recorded-trip-repository.ts';
import type { TripScoringResult } from '../src/services/trip-scoring.ts';
import type { Trip } from '../src/types/trip.ts';

const env = { TRIP_MIN_VALID_READINGS: '5', TRIP_MIN_DISTANCE_KM: '0.1',
    TRIP_SPEEDING_PENALTY_PER_EVENT: '2', TRIP_SPEED_TOLERANCE_KMH: '5', TRIP_FALLBACK_SPEED_THRESHOLD_KMH: '85' };
const config = loadTripScoringConfig(env);
const trip: Trip = { trip_id: 'trip', start_time: '', end_time: '', status: 'Completed', trip_score: 87, distance_km: 0.3 };
const loaded: RecordedTripResult = { status: 'Ready', input: { tripId: 'trip', distanceKm: 0.3,
    samples: [55, 56, 70, 86, 65].map((speed, i) => ({ sample_id: `sample-${i}`, trip_id: 'trip',
        recorded_at: new Date(Date.UTC(2026, 10, 11, 12, 0, i)).toISOString(),
        latitude: 43 + i * 0.0001, longitude: -80, speed_kmh: speed,
        road_speed_limit_kmh: [50, 50, null, null, 60][i]!,
    })) } };

test('loads numeric settings from server config without changing deployed penalty', () => {
    assert.equal(config.speedingPenaltyPerEvent, 2);
    assert.equal(config.toleranceKmh, 5);
    assert.equal(config.fallbackThresholdKmh, 85);
    for (const key of Object.keys(env)) {
        const missing: NodeJS.ProcessEnv = { ...env }; delete missing[key];
        assert.throws(() => loadTripScoringConfig(missing));
    }
    assert.throws(() => loadTripScoringConfig({ ...env, TRIP_SPEED_TOLERANCE_KMH: '-1' }));
    assert.throws(() => loadTripScoringConfig({ ...env, TRIP_FALLBACK_SPEED_THRESHOLD_KMH: '0' }));
});

test('scoring orchestration sends result, per-sample decisions, exact distance and config in one save', async () => {
    let calls = 0;
    const result = await scoreEndedTrip('trip', config, {
        readRecordedTripData: async () => loaded,
        saveTripScore: async (id, result, savedConfig, distance) => {
            calls++;
            assert.equal(id, 'trip');
            assert.equal(result.score, 87);
            assert.ok(result.scoringStatus === 'Scored');
            assert.equal(result.speedingEvents, 2);
            assert.equal(result.sampleDecisions.filter(s => s.usedFallback).length, 2);
            assert.equal(distance, 0.3);
            assert.deepEqual(savedConfig, config);
            return trip;
        },
    });
    assert.equal(result, trip);
    assert.equal(calls, 1);
});

test('not-ready/not-found trips never save or recompute an old completed score', async () => {
    for (const status of ['NotReady', 'NotFound'] as const) {
        assert.equal(await scoreEndedTrip('trip', config, {
            readRecordedTripData: async () => ({ status }), saveTripScore: async () => assert.fail('Do not overwrite'),
        }), null);
    }
});

test('no GPS produces an audited unscored result without invented fallback decisions', async () => {
    let saved: TripScoringResult | undefined;
    await scoreEndedTrip('trip', config, {
        readRecordedTripData: async () => ({ status: 'Unscored', score: null, reason: 'NO_GPS_READINGS' }),
        saveTripScore: async (_id, result) => { saved = result; return { ...trip, trip_score: null }; },
    });
    assert.equal(saved?.score, null);
    assert.deepEqual(saved?.sampleDecisions, []);
});

test('database save failure propagates; no successful-looking trip response', async () => {
    await assert.rejects(scoreEndedTrip('trip', config, { readRecordedTripData: async () => loaded,
        saveTripScore: async () => { throw new Error('save failed'); },
    }), /save failed/);
});
