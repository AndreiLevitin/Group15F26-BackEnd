import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatch } from '../src/lib/route-dispatch.ts';

const handler = dispatch({
    'start-trip': { POST: () => Response.json({ route: 'start-trip' }) },
    'end-trip': { POST: () => Response.json({ route: 'end-trip' }) },
});

async function routeOf(response: Response): Promise<string> {
    return ((await response.json()) as { route: string }).route;
}

test('selects the route from the original public path', async () => {
    const response = await handler(new Request('https://example.test/api/end-trip', { method: 'POST' }));
    assert.equal(response.status, 200);
    assert.equal(await routeOf(response), 'end-trip');
});

test('selects the route from the rewrite query when the path is the group file', async () => {
    const response = await handler(new Request(
        'https://example.test/api/trip-lifecycle?route=start-trip',
        { method: 'POST' },
    ));
    assert.equal(await routeOf(response), 'start-trip');
});

test('a public path is not overridden by a route query parameter', async () => {
    const response = await handler(new Request(
        'https://example.test/api/start-trip?route=end-trip',
        { method: 'POST' },
    ));
    assert.equal(await routeOf(response), 'start-trip');
});

test('unknown routes return 404', async () => {
    for (const url of [
        'https://example.test/api/trip-lifecycle',
        'https://example.test/api/trip-lifecycle?route=sign-in',
        'https://example.test/api/trip-lifecycle?route=constructor',
    ]) {
        const response = await handler(new Request(url, { method: 'POST' }));
        assert.equal(response.status, 404, url);
    }
});

test('unsupported methods return 405 with Allow', async () => {
    const response = await handler(new Request('https://example.test/api/end-trip'));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST');
});
