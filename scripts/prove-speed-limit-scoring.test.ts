import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createTripScoringConfig } from '../src/config/trip-scoring-config.ts';
import { scoreEndedTrip } from '../src/services/score-ended-trip.ts';

const config = createTripScoringConfig({
    minValidReadings: 5,
    minDistanceKm: 0.1,
    toleranceKmh: 5,
    maxIntervalSeconds: 3,
    minMovingSpeedKmh: 5,
    bands: [
        { fromKmh: 0, score: 80 },
        { fromKmh: 16, score: 60 },
        { fromKmh: 30, score: 40 },
        { fromKmh: 50, score: 0 },
    ],
});
const start = Date.UTC(2026, 10, 1, 12);
const expectedScore = 67;
const expectedDistanceKm = 0.5;
// A northbound span of 0.004496608 degrees is approximately 500 m.
const latitudeSpan = 0.004496608;
const speedPattern = [
    { second: 0, speed: 55, limit: 50 },
    { second: 1, speed: 60, limit: 50 },
    { second: 3, speed: 60, limit: 60 },
    { second: 4, speed: 76, limit: 60 },
    { second: 6, speed: 90, limit: 60 },
    { second: 7, speed: 110, limit: 60 },
];
const readings = [
    ...Array.from({ length: 8 }, (_, block) => speedPattern.map(
        reading => ({ ...reading, second: reading.second + block * 8 }),
    )).flat(),
    { second: 64, speed: 60, limit: 60 },
    { second: 67, speed: 60, limit: 60 },
];

function tripSamples(tripId: string) {
    return readings.map(({ second, speed, limit }, index) => ({
        sample_id: randomUUID(),
        trip_id: tripId,
        recorded_at: new Date(start + second * 1000).toISOString(),
        latitude: 43 + latitudeSpan * index / (readings.length - 1),
        longitude: -80,
        speed_kmh: speed,
        road_speed_limit_kmh: limit,
    }));
}

test('AB110: the scoring service saves 67 for the known trip', async t => {
    const tripId = randomUUID();
    const samples = tripSamples(tripId);
    const endTime = samples.at(-1)!.recorded_at;
    const saveTripScore = t.mock.fn<Parameters<typeof scoreEndedTrip>[2]['saveTripScore']>(
        async (id, result, _config, distanceKm) => ({
            trip_id: id,
            start_time: new Date(start).toISOString(),
            end_time: endTime,
            status: 'Completed',
            distance_km: distanceKm ?? null,
            trip_score: result.score,
        }),
    );
    const completed = await scoreEndedTrip(tripId, config, {
        readRecordedTripData: async () => ({ status: 'Ready', input: { tripId, distanceKm: null, samples } }),
        saveTripScore,
    });
    assert.equal(saveTripScore.mock.callCount(), 1);
    const [savedTripId, result, , distanceKm] = saveTripScore.mock.calls[0]!.arguments;
    assert.equal(savedTripId, tripId);
    assert.equal(result.quality.evaluatedReadings, 50);
    assert.ok(distanceKm !== undefined && Math.abs(distanceKm - expectedDistanceKm) < 0.000001);
    assert.equal(result.score, expectedScore);
    assert.equal(completed?.trip_score, expectedScore);
    t.diagnostic(`Expected ${expectedScore}, passed to storage ${result.score}`);
});

test('Story 64 persists the expected score using speed limits stored in Supabase', async t => {
    // Bare Node runs the TypeScript sources directly. These repositories use .js
    // specifiers for their compiled runtime imports.
    const supabaseModule = new URL('../src/lib/supabase.ts', import.meta.url).href;
    const tripModule = new URL('../src/types/trip.ts', import.meta.url).href;
    const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
            if (context.parentURL?.startsWith(new URL('../src/repositories/', import.meta.url).href)) {
                if (specifier === '../lib/supabase.js') return nextResolve(supabaseModule, context);
                if (specifier === '../types/trip.js') return nextResolve(tripModule, context);
            }
            return nextResolve(specifier, context);
        },
    });
    const [{ supabase }, { readRecordedTripData }, { saveTripScore }] = await (async () => {
        try {
            return await Promise.all([
                import('../src/lib/supabase.ts'),
                import('../src/repositories/recorded-trip-repository.ts'),
                import('../src/repositories/trip-score-repository.ts'),
            ]);
        } finally {
            hooks.deregister();
        }
    })();

    const tripId = randomUUID();
    const samples = tripSamples(tripId);
    t.after(async () => {
        for (const table of [
            'trip_interval_scoring', 'trip_sample_scoring', 'trip_scoring_results',
            'trip_sample_speed_limits',
        ]) {
            const { error } = await supabase.from(table).delete().eq('trip_id', tripId);
            assert.equal(error, null, `Cleanup failed for ${table} (trip ${tripId})`);
        }
        // The sample guard allows deletes only while the parent trip is Active.
        const reopened = await supabase.from('trips')
            .update({ status: 'Active', end_time: null, trip_score: null, distance_km: null })
            .eq('trip_id', tripId);
        assert.equal(reopened.error, null, `Could not reopen fixture trip ${tripId} for cleanup`);
        const samples = await supabase.from('trip_data_points').delete().eq('trip_id', tripId);
        assert.equal(samples.error, null, `Could not delete samples for fixture trip ${tripId}`);
        const trip = await supabase.from('trips').delete().eq('trip_id', tripId);
        assert.equal(trip.error, null, `Could not delete fixture trip ${tripId}`);
    });

    const trip = await supabase.from('trips').insert({
        trip_id: tripId,
        start_time: new Date(start).toISOString(),
        status: 'Active',
    });
    assert.equal(trip.error, null, 'Insert the active trip');
    const raw = await supabase.from('trip_data_points').insert(samples.map(
        ({ road_speed_limit_kmh, ...sample }) => ({ ...sample, acceleration: 0 }),
    ));
    assert.equal(raw.error, null, 'Insert GPS samples');
    const processing = await supabase.from('trips')
        .update({ status: 'Processing', end_time: samples.at(-1)!.recorded_at })
        .eq('trip_id', tripId).eq('status', 'Active').select('trip_id').single();
    assert.equal(processing.error, null, 'Move the uploaded trip to Processing');
    const limits = await supabase.from('trip_sample_speed_limits').insert(samples.map(sample => ({
        sample_id: sample.sample_id,
        trip_id: tripId,
        speed_limit_kmh: sample.road_speed_limit_kmh,
        lookup_status: 'available',
        provider: 'fixture',
        fetched_at: new Date(start).toISOString(),
    })));
    assert.equal(limits.error, null, 'Insert posted limits');

    const completed = await scoreEndedTrip(tripId, config, { readRecordedTripData, saveTripScore });
    assert.equal(completed?.status, 'Completed');
    assert.equal(completed?.trip_score, expectedScore);
    const { data, error } = await supabase.from('trip_scoring_results')
        .select('score').eq('trip_id', tripId).single();
    assert.equal(error, null, 'Read the saved scoring result');
    assert.equal(data?.score, expectedScore);
    t.diagnostic(`Trip ${tripId}: expected ${expectedScore}, saved ${data?.score}`);
});
