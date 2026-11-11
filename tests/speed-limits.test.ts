import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkSpeedLimitTrace } from '../src/services/speed-limit-chunks.ts';
import { TomTomSpeedLimitProvider, SpeedLimitProviderError } from '../src/services/tomtom-speed-limit-provider.ts';
import { enrichTripSpeedLimits, type SpeedLimitRepository } from '../src/services/enrich-trip-speed-limits.ts';
import { loadSpeedLimitConfig } from '../src/config/speed-limit-config.ts';
import type { SampleSpeedLimit, SpeedLimitProvider, SpeedLimitSample } from '../src/types/speed-limit.ts';

const point = (i: number, longitude = -80 + i * 0.00001): SpeedLimitSample => ({
    sampleId: `sample-${i}`, recordedAt: new Date(Date.UTC(2026, 10, 11, 12, 0, i)).toISOString(),
    latitude: 43, longitude,
});
const known = (s: SpeedLimitSample): SampleSpeedLimit => ({ sampleId: s.sampleId, speedLimitKmh: 60,
    status: 'available', provider: 'tomtom', fetchedAt: '2026-11-11T12:00:00Z', providerSegmentId: 'road' });
const reply = (count: number, speedLimits: unknown = { value: 60, unit: 'kmph', type: 'Maximum' }) => ({
    route: [{ properties: { id: 'road', speedLimits } }],
    projectedPoints: Array.from({ length: count }, () => ({ properties: { routeIndex: 0, snapResult: 'Matched' } })),
});
function adapter(mock: typeof fetch, maxRequests = 8) {
    return new TomTomSpeedLimitProvider({ apiKey: 'secret-test-key', timeoutMs: 1000, maxRequests,
        fetch: mock, now: () => new Date('2026-11-11T12:00:00Z') });
}

test('point cap splits with one overlapping sample and loses no original ID', () => {
    const samples = Array.from({ length: 5001 }, (_, i) => point(i));
    const chunks = chunkSpeedLimitTrace(samples);
    assert.deepEqual(chunks.map(c => c.length), [4900, 102]);
    assert.equal(chunks[0]!.at(-1)!.sampleId, chunks[1]![0]!.sampleId);
    assert.equal(new Set(chunks.flat().map(s => s.sampleId)).size, samples.length);
});

test('distance cap splits even below point cap; obvious GPS gaps are not bridged', () => {
    const samples = Array.from({ length: 100 }, (_, i) => point(i, -80 + i * 0.02));
    const chunks = chunkSpeedLimitTrace(samples);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(c => c.length < 100));
    assert.deepEqual(chunkSpeedLimitTrace([point(0), point(1, -79)]).map(c => c.length), [1, 1]);
});

test('maps by routeIndex and sample ID; duplicate timestamps remain separate samples', async () => {
    const samples = [point(0), { ...point(1), recordedAt: point(0).recordedAt }];
    const provider = adapter(async (url, init) => {
        assert.equal(new URL(String(url)).searchParams.get('measurementSystem'), 'metric');
        const body = JSON.parse(init!.body as string);
        assert.deepEqual(body.points[0].geometry.coordinates, [-80, 43]);
        assert.equal(body.points[0].properties.timestamp, samples[0]!.recordedAt);
        return Response.json({ route: [
            { properties: { id: 'missing', speedLimits: null } },
            { properties: { id: 'limit', speedLimits: { value: 50, unit: 'kmph', type: 'Maximum' } } },
        ], projectedPoints: [
            { properties: { routeIndex: 1, snapResult: 'Matched' } },
            { properties: { routeIndex: 0, snapResult: 'Matched' } },
        ] });
    });
    const results = await provider.fetchLimits(samples);
    assert.deepEqual(results.map(r => [r.sampleId, r.speedLimitKmh, r.status]), [
        ['sample-0', 50, 'available'], ['sample-1', null, 'missing'],
    ]);
    assert.equal(results[0]!.providerSegmentId, 'limit');
    assert.equal(results[0]!.fetchedAt, '2026-11-11T12:00:00.000Z');
});

test('unknown, non-maximum, non-metric and unmatched results never become posted limits', async () => {
    for (const value of [null, { value: 60, unit: 'mph', type: 'Maximum' },
        { value: 60, unit: 'kmph', type: 'Recommended' }, { value: 0, unit: 'kmph', type: 'Maximum' }]) {
        const provider = adapter(async () => Response.json(reply(2, value)));
        assert.ok((await provider.fetchLimits([point(0), point(1)])).every(r => r.status === 'missing' && r.speedLimitKmh === null));
    }
    const provider = adapter(async () => Response.json({ route: [], projectedPoints: [
        { properties: { snapResult: 'Unmatched' } }, { properties: { snapResult: 'Unmatched' } },
    ] }));
    assert.ok((await provider.fetchLimits([point(0), point(1)])).every(r => r.status === 'unmatched'));
});

test('single points and separated GPS islands do not consume provider requests', async () => {
    const provider = adapter(async () => assert.fail('Must not fetch a single point'));
    assert.deepEqual(await provider.fetchLimits([]), []);
    assert.equal((await provider.fetchLimits([point(0)]))[0]!.status, 'insufficient_trace');
    assert.ok((await provider.fetchLimits([point(0), point(1, -79)])).every(r => r.status === 'insufficient_trace'));
});

test('distance/point limit HTTP 400 subdivides with overlap and merges each sample once', async () => {
    let calls = 0;
    const provider = adapter(async (_url, init) => {
        const count = JSON.parse(init!.body as string).points.length;
        calls++;
        return count > 3 ? new Response('{}', { status: 400 }) : Response.json(reply(count));
    });
    const result = await provider.fetchLimits(Array.from({ length: 5 }, (_, i) => point(i)));
    assert.equal(calls, 3);
    assert.deepEqual(result.map(r => r.sampleId), ['sample-0', 'sample-1', 'sample-2', 'sample-3', 'sample-4']);
});

test('bounded request budget stops subdivision; transient failures are not missing road data', async () => {
    const provider = adapter(async () => new Response('{}', { status: 400 }), 1);
    await assert.rejects(provider.fetchLimits([point(0), point(1), point(2)]),
        (e: unknown) => e instanceof SpeedLimitProviderError && e.code === 'request_limit');
    for (const status of [401, 403, 429, 500, 503]) {
        await assert.rejects(adapter(async () => new Response('{}', { status })).fetchLimits([point(0), point(1)]), SpeedLimitProviderError);
    }
    await assert.rejects(adapter(async () => { throw new Error('secret-test-key in private URL'); }).fetchLimits([point(0), point(1)]),
        (e: unknown) => e instanceof Error && !e.message.includes('secret-test-key') && e.cause === undefined);
});

test('malformed responses fail instead of storing false missing data', async () => {
    const malformed = [null, {}, reply(1), { ...reply(2), route: [] },
        { ...reply(2), projectedPoints: [{ properties: { routeIndex: -1, snapResult: 'Matched' } }, { properties: {} }] }];
    for (const result of malformed) {
        await assert.rejects(adapter(async () => Response.json(result)).fetchLimits([point(0), point(1)]), SpeedLimitProviderError);
    }
});

function repository(claim: 'claimed' | 'cached' | 'busy' = 'claimed') {
    const saved: SampleSpeedLimit[][] = [];
    let released = false;
    const repo: SpeedLimitRepository = {
        readSamples: async () => [point(0), point(1)],
        claim: async () => claim,
        complete: async (_id, _token, _samples, limits) => { saved.push([...limits]); },
        release: async () => { released = true; },
    };
    return { repo, saved, released: () => released };
}

test('completed enrichment is cached; concurrent request does not duplicate provider calls', async () => {
    const provider: SpeedLimitProvider = { name: 'tomtom', fetchLimits: async () => assert.fail('Provider must not be called') };
    await enrichTripSpeedLimits('trip', provider, repository('cached').repo);
    await assert.rejects(enrichTripSpeedLimits('trip', provider, repository('busy').repo));
});

test('persists a complete normalized trace once; partial responses and DB/provider failures stay retryable', async () => {
    const successful = repository();
    const provider: SpeedLimitProvider = { name: 'tomtom', fetchLimits: async samples => samples.map(known) };
    await enrichTripSpeedLimits('trip', provider, successful.repo);
    assert.equal(successful.saved[0]!.length, 2);
    for (const fetchLimits of [async () => [known(point(0))], async () => { throw new Error('provider failed'); }]) {
        const failed = repository();
        await assert.rejects(enrichTripSpeedLimits('trip', { name: 'tomtom', fetchLimits }, failed.repo));
        assert.equal(failed.saved.length, 0);
        assert.equal(failed.released(), true);
    }
    const failed = repository();
    failed.repo.complete = async () => { throw new Error('Database failure'); };
    await assert.rejects(enrichTripSpeedLimits('trip', provider, failed.repo));
    assert.equal(failed.released(), true);
});

test('server configuration is opt-in, validates bounds and requires a key only when enabled', () => {
    assert.equal(loadSpeedLimitConfig({}), null);
    assert.equal(loadSpeedLimitConfig({ TRIP_SPEED_LIMIT_ENRICHMENT_ENABLED: 'false' }), null);
    assert.throws(() => loadSpeedLimitConfig({ TRIP_SPEED_LIMIT_ENRICHMENT_ENABLED: 'true' }));
    assert.throws(() => loadSpeedLimitConfig({ TRIP_SPEED_LIMIT_ENRICHMENT_ENABLED: 'yes' }));
    const env = { TRIP_SPEED_LIMIT_ENRICHMENT_ENABLED: 'true', TOMTOM_API_KEY: 'secret' };
    assert.equal(loadSpeedLimitConfig(env)!.apiKey, 'secret');
    assert.throws(() => loadSpeedLimitConfig({ ...env, TOMTOM_MAX_REQUESTS_PER_TRIP: '100' }));
});
