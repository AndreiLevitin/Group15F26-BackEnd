import assert from 'node:assert/strict';
import test from 'node:test';
import { preflight, withCors } from '../src/lib/cors.ts';

function options(origin = 'http://localhost:8081', method = 'POST', headers = 'content-type') {
    return new Request('https://example.test/api/sign-up', {
        method: 'OPTIONS',
        headers: {
            Origin: origin,
            'Access-Control-Request-Method': method,
            'Access-Control-Request-Headers': headers,
        },
    });
}

test('local browser JSON preflight returns 204 with CORS headers', () => {
    const response = preflight(options());
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8081');
    assert.match(response.headers.get('Access-Control-Allow-Headers') ?? '', /Content-Type/);
});

test('authenticated history preflight allows Authorization', () => {
    const response = preflight(options('http://localhost:8081', 'GET', 'authorization, content-type'));
    assert.equal(response.status, 204);
    assert.match(response.headers.get('Access-Control-Allow-Headers') ?? '', /Authorization/);
});

test('unknown origins, methods and headers are rejected', () => {
    assert.equal(preflight(options('https://untrusted.example')).status, 403);
    assert.equal(preflight(options('http://localhost:8081', 'DELETE')).status, 403);
    assert.equal(preflight(options('http://localhost:8081', 'POST', 'x-custom')).status, 403);
});

test('preflight does not execute the business handler', async () => {
    const handler = withCors(() => assert.fail('must not authenticate or write data'));
    assert.equal((await handler(options())).status, 204);
});

test('CORS preserves authentication errors and makes them readable to the browser', async () => {
    const handler = withCors(() => Response.json(
        { error: 'unauthorized' },
        { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    ));
    const response = await handler(new Request('https://example.test/api/trip-history', {
        headers: { Origin: 'http://localhost:8081' },
    }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8081');
    assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('native requests without Origin still execute normally', async () => {
    const handler = withCors(() => Response.json({ ok: true }, { status: 201 }));
    const response = await handler(new Request('https://example.test/api/start-trip', { method: 'POST' }));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('unknown browser origins cannot execute the business handler', async () => {
    const handler = withCors(() => assert.fail('must not execute'));
    const response = await handler(new Request('https://example.test/api/sign-up', {
        method: 'POST', headers: { Origin: 'https://untrusted.example' },
    }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});
