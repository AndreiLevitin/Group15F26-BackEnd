import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreEndedTrip } from '../src/services/score-ended-trip.ts';
import { loadTripScoringConfig } from '../src/config/trip-scoring-config.ts';
import type { RecordedTripResult } from '../src/repositories/recorded-trip-repository.ts';
import type { TripScoringResult } from '../src/services/trip-scoring.ts';
import type { Trip } from '../src/types/trip.ts';

const env = { TRIP_MIN_VALID_READINGS: '5', TRIP_MIN_DISTANCE_KM: '0.1',
    TRIP_SPEED_TOLERANCE_KMH: '5', TRIP_MAX_SCORING_INTERVAL_SECONDS: '3', TRIP_MIN_MOVING_SPEED_KMH: '5',
    TRIP_SPEED_SCORE_BANDS: JSON.stringify([{fromKmh:0,score:80},{fromKmh:16,score:60},{fromKmh:30,score:40},{fromKmh:50,score:0}]) };
const config = loadTripScoringConfig(env);
const trip: Trip = { trip_id: 'trip', start_time: '', end_time: '', status: 'Completed', trip_score: 87, distance_km: 0.3 };
const loaded: RecordedTripResult = { status: 'Ready', input: { tripId: 'trip', distanceKm: 0.3,
    samples: [55, 56, 70, 86, 65].map((speed, i) => ({ sample_id: `sample-${i}`, trip_id: 'trip',
        recorded_at: new Date(Date.UTC(2026, 10, 11, 12, 0, i)).toISOString(),
        latitude: 43 + i * 0.0001, longitude: -80, speed_kmh: speed,
        road_speed_limit_kmh: [50, 50, 60, 60, 60][i]!,
    })) } };

test('loads and validates band scoring settings from server config', () => {
    assert.equal(config.bands.length, 4);
    assert.equal(config.toleranceKmh, 5);
    assert.equal(config.maxIntervalSeconds, 3);
    for (const key of Object.keys(env)) {
        const missing: NodeJS.ProcessEnv = { ...env }; delete missing[key];
        assert.deepEqual(loadTripScoringConfig(missing), config);
    }
    assert.throws(() => loadTripScoringConfig({ ...env, TRIP_SPEED_TOLERANCE_KMH: '-1' }));
    assert.throws(() => loadTripScoringConfig({ ...env, TRIP_SPEED_SCORE_BANDS: 'null' }));
});

test('absent env returns agreed defaults and independently copied bands', () => {
    assert.deepEqual(loadTripScoringConfig({}), config);
    const first = loadTripScoringConfig({});
    first.bands[0]!.score = 1;
    assert.deepEqual(loadTripScoringConfig({}), config);
});

test('valid partial overrides replace defaults, including legacy minimum distance', () => {
    const r = loadTripScoringConfig({ TRIP_MIN_VALID_READINGS: '6', TRIP_MIN_DISTANCE_KM: '0.0001',
        TRIP_SPEED_TOLERANCE_KMH: '7', TRIP_MAX_SCORING_INTERVAL_SECONDS: '2',
        TRIP_MIN_MOVING_SPEED_KMH: '4', TRIP_SPEED_SCORE_BANDS: '[{"fromKmh":0,"score":75},{"fromKmh":20,"score":0}]' });
    assert.deepEqual(r, { minValidReadings:6, minDistanceKm:0.0001, toleranceKmh:7,
        maxIntervalSeconds:2, minMovingSpeedKmh:4, bands:[{fromKmh:0,score:75},{fromKmh:20,score:0}] });
    assert.deepEqual(loadTripScoringConfig({ TRIP_MIN_DISTANCE_KM:'0.2' }), { ...config, minDistanceKm:0.2 });
});

test('present but empty or malformed overrides never silently use defaults', () => {
    for (const key of Object.keys(env)) for (const value of ['', '  ', 'invalid', 'Infinity']) {
        assert.throws(() => loadTripScoringConfig({ [key]: value }), key);
    }
    for (const bands of ['null', '{}', '[]', '[{"fromKmh":0,"score":80},{"fromKmh":3,"score":0}]']) {
        assert.throws(() => loadTripScoringConfig({ TRIP_SPEED_SCORE_BANDS:bands }));
    }
    assert.throws(() => loadTripScoringConfig({ TRIP_MIN_VALID_READINGS:'1' }));
    assert.throws(() => loadTripScoringConfig({ TRIP_MAX_SCORING_INTERVAL_SECONDS:'0' }));
});

test('scoring orchestration sends result, per-sample decisions, exact distance and config in one save', async () => {
    let calls = 0;
    const result = await scoreEndedTrip('trip', config, {
        readRecordedTripData: async () => loaded,
        saveTripScore: async (id, result, savedConfig, distance) => {
            calls++;
            assert.equal(id, 'trip');
            assert.equal(result.score, 80);
            assert.ok(result.scoringStatus === 'Scored');
            assert.equal(result.speedingEvents, 1);
            assert.equal(result.sampleDecisions.filter(s => s.usedFallback).length, 0);
            assert.equal(result.intervalDecisions.length, 4);
            assert.equal(result.quality.evaluatedSeconds, 4);
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
