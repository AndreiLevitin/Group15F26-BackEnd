import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { loadTripScoringConfig } from '../src/config/trip-scoring-config.ts';
import type { TripSampleRow } from '../src/repositories/user-trip-repository.ts';
import { completeTrip } from '../src/services/complete-trip.ts';
import { createEndTripHandler } from '../src/services/end-trip.ts';
import type { Authenticate } from '../src/services/request-auth.ts';
import type { TripScoringResult } from '../src/services/trip-scoring.ts';
import { createUploadTripSamplesHandler } from '../src/services/upload-trip-samples.ts';
import type { Trip } from '../src/types/trip.ts';

test('AB#111: End scores only the latest complete upload for the same trip', async t => {
    const tripId = '123e4567-e89b-42d3-a456-426614174000';
    const start = Date.UTC(2026, 10, 1, 12);
    const trip: Trip = {
        trip_id: tripId, start_time: new Date(start).toISOString(),
        status: 'Active', end_time: null, distance_km: null, trip_score: null,
    };
    const completeSamples = [50, 50, 50, 50, 50, 70, 70].map((speed, index) => ({
        timestamp: new Date(start + index * 1000).toISOString(),
        speed, acceleration: 0, latitude: 43 + index * 0.0003, longitude: -80,
    }));
    const firstSamples = completeSamples.slice(0, 5);
    const stored: (TripSampleRow & { sample_id: string })[] = [];
    const savedScores: (number | null)[] = [];
    let nextSampleId = 0;
    const config = loadTripScoringConfig({});
    const dbOrigin = 'https://supabase.example.test';

    // Exercise the real Supabase repositories without a network or a test database.
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        assert.equal(url.origin, dbOrigin);
        switch (`${request.method} ${url.pathname}`) {
            case 'GET /rest/v1/trips':
                assert.equal(url.searchParams.get('trip_id'), `eq.${tripId}`);
                return Response.json([trip]);
            case 'PATCH /rest/v1/trips': {
                assert.equal(url.searchParams.get('trip_id'), `eq.${tripId}`);
                assert.equal(trip.status, 'Active');
                Object.assign(trip, await request.json());
                return Response.json([trip]);
            }
            case 'DELETE /rest/v1/trip_data_points':
                assert.equal(url.searchParams.get('trip_id'), `eq.${tripId}`);
                stored.length = 0;
                return new Response(null, { status: 204 });
            case 'POST /rest/v1/trip_data_points': {
                const rows: TripSampleRow[] = await request.json();
                for (const row of rows) {
                    assert.equal(row.trip_id, tripId);
                    stored.push({ ...row, sample_id: String(++nextSampleId) });
                }
                return new Response(null, { status: 201 });
            }
            case 'GET /rest/v1/trip_data_points':
                assert.equal(url.searchParams.get('trip_id'), `eq.${tripId}`);
                return Response.json(stored.slice(Number(url.searchParams.get('offset'))).map(row => ({
                    ...row, limit: { speed_limit_kmh: 50, lookup_status: 'available' },
                })));
            case 'POST /rest/v1/rpc/save_trip_band_scoring_result': {
                const body: { p_trip_id: string; p_result: TripScoringResult } = await request.json();
                assert.equal(body.p_trip_id, tripId);
                assert.equal(trip.status, 'Processing');
                savedScores.push(body.p_result.score);
                trip.status = 'Completed';
                trip.trip_score = body.p_result.score;
                return Response.json(trip);
            }
            default:
                return assert.fail(`Unexpected storage request: ${request.method} ${url.pathname}`);
        }
    });

    const testEnv = {
        SUPABASE_URL: dbOrigin,
        SUPABASE_SECRET_KEY: 'test-secret',
        SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
    };
    for (const [key, value] of Object.entries(testEnv)) {
        const original = process.env[key];
        process.env[key] = value;
        t.after(() => {
            if (original === undefined) delete process.env[key];
            else process.env[key] = original;
        });
    }
    // Native Node runs the TS sources directly. Map the repositories' compiled
    // runtime specifiers back to the corresponding TS source during import.
    const runtimeFiles = new Map([
        ['../lib/supabase.js', new URL('../src/lib/supabase.ts', import.meta.url).href],
        ['../types/trip.js', new URL('../src/types/trip.ts', import.meta.url).href],
    ]);
    const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
            return nextResolve(runtimeFiles.get(specifier) ?? specifier, context);
        },
    });
    const [{ userTripRepository }, { tripCompletionRepository }, { readRecordedTripData }, { saveTripScore }] =
        await Promise.all([
            import('../src/repositories/user-trip-repository.ts'),
            import('../src/repositories/trip-completion-repository.ts'),
            import('../src/repositories/recorded-trip-repository.ts'),
            import('../src/repositories/trip-score-repository.ts'),
        ]).finally(() => hooks.deregister());

    const authenticate: Authenticate = async () => ({
        ok: true, access: { userId: 'test-driver', accessToken: 'test-user-token' },
    });
    const upload = createUploadTripSamplesHandler(authenticate, userTripRepository);
    const end = createEndTripHandler(authenticate, userTripRepository, id => completeTrip(id, {
        repository: tripCompletionRepository,
        scoring: { readRecordedTripData, saveTripScore },
        getConfig: () => config,
        enrich: async () => {},
        log: event => t.diagnostic(JSON.stringify(event)),
    }));
    const post = (path: string, body: object) => new Request(`https://backend.example.test/api/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    for (const samples of [firstSamples, completeSamples]) {
        const response = await upload(post('upload-trip-samples', { tripId, samples }));
        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), { trip_id: tripId, inserted: samples.length });
        assert.deepEqual(stored.map(row => ({
            timestamp: row.recorded_at, speed: row.speed_kmh, acceleration: row.acceleration,
            latitude: row.latitude, longitude: row.longitude,
        })), samples);
        assert.equal(trip.status, 'Active');
        assert.deepEqual(savedScores, []);
    }

    // With 50 km/h limits, the first upload alone would score 100. The final
    // upload adds endpoint scores of 60, so equal one-second intervals yield
    // (100 + 100 + 100 + 100 + 80 + 60) / 6 = 90.
    const response = await end(post('end-trip', { tripId }));
    assert.equal(response.status, 200);
    const result: { trip: Trip } = await response.json();
    assert.equal(result.trip.trip_id, tripId);
    assert.equal(result.trip.status, 'Completed');
    assert.equal(result.trip.trip_score, 90);
    assert.deepEqual(savedScores, [90]);
    t.diagnostic('First upload: 5 samples (would score 100). Latest upload: 7 samples, score 90.');
});
