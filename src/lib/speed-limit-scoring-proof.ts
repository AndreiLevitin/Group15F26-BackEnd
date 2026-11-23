import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTripScoringConfig } from '../config/trip-scoring-config.ts';
import { scoreEndedTrip, type ScoringDependencies } from '../services/score-ended-trip.ts';

export const config = createTripScoringConfig({
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
export const expectedScore = 67;
export const expectedDistanceKm = 0.5;
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

export function tripSamples(tripId: string) {
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

export async function proveSpeedLimitScoring(supabase: SupabaseClient, scoring: ScoringDependencies) {
    const tripId = randomUUID();
    const samples = tripSamples(tripId);
    async function cleanup() {
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
    }

    let savedScore: number;
    try {
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

        const completed = await scoreEndedTrip(tripId, config, scoring);
        assert.equal(completed?.status, 'Completed');
        assert.equal(completed?.trip_score, expectedScore);
        const { data, error } = await supabase.from('trip_scoring_results')
            .select('score').eq('trip_id', tripId).single();
        assert.equal(error, null, 'Read the saved scoring result');
        assert.equal(data?.score, expectedScore);
        savedScore = data.score;
    } finally {
        await cleanup();
    }

    return { tripId, expectedScore, savedScore, cleanup: 'passed' as const };
}
