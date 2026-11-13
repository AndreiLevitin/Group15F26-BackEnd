import assert from 'node:assert/strict';
import test from 'node:test';
import { completeTrip, type TripCompletionDependencies, type CompletionLog } from '../src/services/complete-trip.ts';
import { enrichTripSpeedLimits, type SpeedLimitRepository } from '../src/services/enrich-trip-speed-limits.ts';
import { TomTomSpeedLimitProvider } from '../src/services/tomtom-speed-limit-provider.ts';
import { SpeedLimitProviderError } from '../src/types/speed-limit-errors.ts';
import { logTripCompletion } from '../src/lib/trip-log.ts';
import type { Trip } from '../src/types/trip.ts';
import type { SampleSpeedLimit } from '../src/types/speed-limit.ts';

const config = { minValidReadings: 5, minDistanceKm: 0.1, toleranceKmh: 5, maxIntervalSeconds: 3, minMovingSpeedKmh: 5,
    bands: [{fromKmh:0,score:80},{fromKmh:16,score:60},{fromKmh:30,score:40},{fromKmh:50,score:0}] };
const trip: Trip = { trip_id: 'trip', start_time: '', end_time: '2026-11-11T12:00:00Z', status: 'Processing', trip_score: null, distance_km: 0.3 };
function dependencies() {
    let state = { ...trip };
    const log: CompletionLog[] = [];
    const deps: TripCompletionDependencies = {
        repository: { beginProcessing: async () => null, findTrip: async () => state },
        scoring: {
            readRecordedTripData: async () => ({ status: 'Unscored', score: null, reason: 'NO_GPS_READINGS' }),
            saveTripScore: async (_id, result) => { state = { ...state, status: 'Completed', trip_score: result.score }; return state; },
        },
        getConfig: () => config, enrich: async () => {}, log: event => { log.push(event); },
    };
    return { deps, log, setTrip: (value: Trip) => { state = value; } };
}

test('complete-trip preserves old completed scores without reading new config or calling a provider', async () => {
    const s = dependencies(); s.setTrip({ ...trip, status: 'Completed', trip_score: 87 });
    s.deps.getConfig = () => assert.fail('No config needed');
    s.deps.enrich = async () => assert.fail('No new provider call');
    const result = await completeTrip('trip', s.deps);
    assert.equal(result.kind, 'Completed');
    if (result.kind === 'Completed') assert.equal(result.trip.trip_score, 87);
});

test('unknown and non-processing trips do not enter scoring', async () => {
    const s = dependencies(); s.deps.enrich = async () => assert.fail('No provider');
    s.deps.repository.findTrip = async () => null;
    assert.equal((await completeTrip('trip', s.deps)).kind, 'NotFound');
    s.deps.repository.findTrip = async () => ({ ...trip, status: 'Invalid' });
    assert.equal((await completeTrip('trip', s.deps)).kind, 'NotActive');
});

test('configuration, authentication, quota and budget failures retain safe diagnostic categories', async () => {
    for (const [code, retryable] of [['authentication_failed', false], ['quota_exceeded', true], ['request_limit', false]] as const) {
        const s = dependencies();
        s.deps.enrich = async () => { throw new SpeedLimitProviderError(code, code === 'quota_exceeded' ? 429 : 401); };
        s.deps.scoring.saveTripScore = async () => assert.fail('No partial score');
        const result = await completeTrip('trip', s.deps);
        assert.equal(result.kind, 'Failed');
        if (result.kind === 'Failed') assert.equal(result.retryable, retryable);
        assert.equal(s.log[0]!.stage, 'enrichment');
        assert.equal(s.log[0]!.code, code);
    }
    const s = dependencies();
    s.deps.getConfig = () => { throw Error('private config secret'); };
    const result = await completeTrip('trip', s.deps);
    assert.equal(result.kind, 'Failed');
    assert.equal(s.log[0]!.stage, 'configuration');
    assert.ok(!JSON.stringify(s.log).includes('secret'));
});

test('a concurrent completion is returned even when this request fails enrichment', async () => {
    const s = dependencies();
    s.deps.enrich = async () => {
        s.setTrip({ ...trip, status: 'Completed', trip_score: 97 });
        throw Error('Another request won');
    };
    const result = await completeTrip('trip', s.deps);
    assert.equal(result.kind, 'Completed');
    assert.equal(s.log.length, 0);
});

test('whole use case filters invalid GPS, enriches valid readings, scores and saves without fallback for invalid data', async () => {
    const s = dependencies();
    const raw = [55, 56, 70, 86, 65, 100].map((speed, i) => ({ sample_id: `s${i}`, trip_id: 'trip',
        recorded_at: new Date(Date.UTC(2026, 10, 11, 12, 0, i)).toISOString(),
        latitude: i === 5 ? 91 : 43 + i * 0.0001, longitude: -80, speed_kmh: speed }));
    let stored: readonly SampleSpeedLimit[] = [];
    let providerCalls = 0;
    const repo: SpeedLimitRepository = {
        readSamples: async () => raw.map(r => ({ sampleId: r.sample_id, recordedAt: r.recorded_at, latitude: r.latitude, longitude: r.longitude })),
        claim: async () => 'claimed', complete: async (_id, _token, _samples, results) => { stored = results; }, release: async () => {},
    };
    const provider = new TomTomSpeedLimitProvider({ apiKey: 'test', timeoutMs: 1000, maxRequests: 8,
        fetch: async (_url, init) => {
            providerCalls++;
            const points = JSON.parse(init!.body as string).points;
            assert.equal(points.length, 5);
            return Response.json({ route: [50,50,null,null,60].map(value => ({ properties: {
                speedLimits: value === null ? null : { value, unit: 'kmph', type: 'Maximum' },
            } })), projectedPoints: points.map((_: unknown, i: number) => ({ properties: { routeIndex: i, snapResult: 'Matched' } })) });
        },
    });
    s.deps.enrich = id => enrichTripSpeedLimits(id, provider, repo);
    s.deps.scoring.readRecordedTripData = async () => ({ status: 'Ready', input: { tripId: 'trip', distanceKm: 0.3,
        samples: raw.map(r => ({ ...r, road_speed_limit_kmh: stored.find(l => l.sampleId === r.sample_id)!.speedLimitKmh })),
    } });
    const save = s.deps.scoring.saveTripScore;
    s.deps.scoring.saveTripScore = async (id, result, cfg, distance) => {
        assert.equal(result.ignoredReadings, 1);
        assert.equal(result.sampleDecisions[5]!.usedFallback, null);
        assert.equal(result.sampleDecisions.filter(r => r.usedFallback).length, 0);
        assert.equal(result.quality.evaluatedReadings, 2);
        return save(id, result, cfg, distance);
    };
    const result = await completeTrip('trip', s.deps);
    assert.equal(result.kind, 'Completed');
    if (result.kind === 'Completed') assert.equal(result.trip.trip_score, null);
    assert.equal(stored.find(l => l.sampleId === 's5')!.status, 'invalid_sample');
    assert.equal(providerCalls, 1);
    await completeTrip('trip', s.deps);
    assert.equal(providerCalls, 1);
});

test('logging failure cannot replace business failure and JSON logging excludes arbitrary payload fields', async () => {
    const s = dependencies(); s.deps.log = () => { throw Error('logger down'); };
    s.deps.enrich = async () => { throw new SpeedLimitProviderError('quota_exceeded', 429); };
    assert.equal((await completeTrip('trip', s.deps)).kind, 'Failed');
    const original = console.error;
    let output = '';
    console.error = text => { output = String(text); };
    try {
        const event = { tripId: 'trip', stage: 'enrichment' as const, code: 'quota_exceeded', retryable: true, apiKey: 'secret', gps: 'private' };
        logTripCompletion('request', event);
        assert.ok(!output.includes('secret') && !output.includes('private'));
        assert.equal(JSON.parse(output).requestId, 'request');
    } finally { console.error = original; }
});
