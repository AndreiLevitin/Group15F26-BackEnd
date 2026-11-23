import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import {
    config, expectedDistanceKm, expectedScore, proveSpeedLimitScoring, tripSamples,
} from '../src/lib/speed-limit-scoring-proof.ts';
import { scoreEndedTrip } from '../src/services/score-ended-trip.ts';

test('AB110: the scoring service saves 67 for the known trip', async t => {
    const tripId = randomUUID();
    const samples = tripSamples(tripId);
    const endTime = samples.at(-1)!.recorded_at;
    const saveTripScore = t.mock.fn<Parameters<typeof scoreEndedTrip>[2]['saveTripScore']>(
        async (id, result, _config, distanceKm) => ({
            trip_id: id,
            start_time: samples[0]!.recorded_at,
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

    const result = await proveSpeedLimitScoring(supabase, { readRecordedTripData, saveTripScore });
    t.diagnostic(`Trip ${result.tripId}: expected ${result.expectedScore}, saved ${result.savedScore}; cleanup ${result.cleanup}`);
});
