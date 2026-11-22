import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildScoreAverages,
    createScoreAveragesHandler,
    scoreAveragePeriods,
} from '../src/services/score-averages-handler.ts';
import { withCors } from '../src/lib/cors.ts';

const access = {
    userId: '94000000-0000-4000-8000-000000000001',
    accessToken: 'verified-test-token',
};

const authenticated = async () => ({ ok: true as const, access });

function storedRows(score: number | null = 75, count = 2) {
    return scoreAveragePeriods.map(period => ({
        period_type: period,
        period_start: '2026-11-01T00:00:00-04:00',
        average_score: score,
        trip_count: count,
        calculated_at: '2026-11-21T20:00:00-05:00',
    }));
}

test('real zero scores and empty periods remain distinct', () => {
    const zero = buildScoreAverages(storedRows(0, 1));
    const empty = buildScoreAverages(storedRows(null, 0));

    assert.equal(zero.length, 6);
    assert.ok(zero.every(row => row.averageScore === 0 && row.tripCount === 1));
    assert.ok(empty.every(row => row.averageScore === null && row.tripCount === 0));
});

test('period order is consistent without changing the supplied rows', () => {
    const rows = storedRows().reverse();
    const before = structuredClone(rows);
    const result = buildScoreAverages(rows);

    assert.deepEqual(result.map(row => row.period), [...scoreAveragePeriods]);
    assert.equal(result[0]?.averageScore, 75);
    assert.equal(result[0]?.tripCount, 2);
    assert.deepEqual(rows, before);
});

test('missing, duplicate and malformed averages are rejected', () => {
    const rows = storedRows();
    const malformed: unknown[] = [
        null,
        [],
        rows.slice(1),
        [rows[0], ...rows.slice(0, 5)],
        rows.map(row => ({ ...row, average_score: 101 })),
        rows.map(row => ({ ...row, average_score: -1 })),
        rows.map(row => ({ ...row, average_score: NaN })),
        rows.map(row => ({ ...row, trip_count: 1.5 })),
        rows.map(row => ({ ...row, trip_count: -1 })),
        rows.map(row => ({ ...row, period_start: 'invalid' })),
        rows.map(row => ({ ...row, calculated_at: 'invalid' })),
        storedRows(null, 2),
        storedRows(0, 0),
    ];

    for (const value of malformed) {
        assert.throws(() => buildScoreAverages(value));
    }
});

test('an unauthenticated request never reads averages', async () => {
    let called = false;
    const handler = createScoreAveragesHandler(
        async () => { called = true; return storedRows(); },
        async () => ({
            ok: false as const,
            response: Response.json(
                { error: 'unauthorized' },
                { status: 401, headers: { 'Cache-Control': 'no-store' } },
            ),
        }),
    );

    const response = await handler(new Request('https://example.test/api/score-averages'));
    assert.equal(response.status, 401);
    assert.equal(called, false);
});

test('the endpoint uses verified identity and ignores a user ID in the URL', async () => {
    const handler = createScoreAveragesHandler(
        async received => {
            assert.deepEqual(received, access);
            return storedRows();
        },
        authenticated,
    );

    const response = await handler(new Request(
        'https://example.test/api/score-averages?userId=another-account',
    ));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), {
        timeZone: 'America/Toronto',
        averages: buildScoreAverages(storedRows()),
    });
});

test('database failure returns 503 without exposing internal details', async () => {
    const handler = createScoreAveragesHandler(
        async () => { throw new Error('private database details'); },
        authenticated,
    );

    const response = await handler(new Request('https://example.test/api/score-averages'));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'score_averages_unavailable' });
});

test('missing database rows are an error rather than invented empty averages', async () => {
    const handler = createScoreAveragesHandler(async () => [], authenticated);
    const response = await handler(new Request('https://example.test/api/score-averages'));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'score_averages_unavailable' });
});

test('browser preflight permits Authorization without querying averages', async () => {
    let called = false;
    const handler = withCors(createScoreAveragesHandler(
        async () => { called = true; return storedRows(); },
        authenticated,
    ));

    const response = await handler(new Request('https://example.test/api/score-averages', {
        method: 'OPTIONS',
        headers: {
            Origin: 'http://localhost:8081',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'authorization',
        },
    }));

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8081');
    assert.equal(called, false);
});
