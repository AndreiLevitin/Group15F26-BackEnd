
// AB#102: a driver's profile, vehicle and policy belong to the signed-in
// account; identity comes only from a verified access token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticator } from '../src/services/request-auth.ts';
import {
    createProfileReadHandler,
    createProfileSaveHandler,
} from '../src/services/profile-handler.ts';
import type { Profile } from '../src/types/profile.ts';

const emptyProfile: Profile = { driver: null, vehicle: null, policy: null };

const savedProfile: Profile = {
    driver: {
        userId: 'verified-owner',
        name: 'Sam Driver',
        email: 'sam@example.com',
        licenceNo: 'D1234',
    },
    vehicle: {
        vehicleId: 'vehicle-1',
        driverId: 'verified-owner',
        make: 'Honda',
        model: 'Civic',
        year: 2022,
        plateNo: 'ABC 123',
    },
    policy: {
        policyNo: 'P-100',
        driverId: 'verified-owner',
        vehicleId: 'vehicle-1',
        insurer: 'Acme',
        status: 'Active',
    },
};

function getRequest(token?: string) {
    return new Request('https://example.com/api/profile', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
}

function postRequest(body: unknown, token?: string) {
    return new Request('https://example.com/api/profile', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const signedIn = () => createAuthenticator(async () => ({ id: 'verified-owner' }));
const signedOut = () => createAuthenticator(async () => null);

// Read tests

test('missing or invalid token never reads the profile', async () => {
    let calls = 0;
    const handler = createProfileReadHandler(signedOut(), {
        findProfile: async () => { calls++; return emptyProfile; },
    });
    for (const token of [undefined, 'invalid']) {
        const response = await handler(getRequest(token));
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(calls, 0);
});

test('read returns the profile for the verified identity only', async () => {
    const handler = createProfileReadHandler(signedIn(), {
        findProfile: async (access) => {
            assert.deepEqual(access, {
                userId: 'verified-owner',
                accessToken: 'valid-token',
            });
            return savedProfile;
        },
    });
    const response = await handler(getRequest('valid-token'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), savedProfile);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('read failure returns 503 instead of an empty profile, so the client never mistakes it for no profile saved', async () => {
    const handler = createProfileReadHandler(signedIn(), {
        findProfile: async () => { throw new Error('database failure'); },
    });
    const response = await handler(getRequest('valid-token'));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'profile_unavailable' });
});

// Save to backend tests

test('missing or invalid token never saves the profile', async () => {
    let calls = 0;
    const handler = createProfileSaveHandler(signedOut(), {
        saveProfile: async () => { calls++; return savedProfile; },
    });
    const body = { name: 'Sam Driver', email: 'sam@example.com' };
    for (const token of [undefined, 'invalid']) {
        const response = await handler(postRequest(body, token));
        assert.equal(response.status, 401);
    }
    assert.equal(calls, 0);
});

test('save stores the edited profile and returns it as stored', async () => {
    const handler = createProfileSaveHandler(signedIn(), {
        saveProfile: async (access, update) => {
            assert.deepEqual(access, {
                userId: 'verified-owner',
                accessToken: 'valid-token',
            });
            assert.deepEqual(update, {
                name: 'Sam Driver',
                email: 'sam@example.com',
                licenceNo: 'D1234',
                vehicle: {
                    make: 'Honda',
                    model: 'Civic',
                    year: 2022,
                    plateNo: 'ABC 123',
                },
                policy: { policyNo: 'P-100', insurer: 'Acme', status: 'Active' },
            });
            return savedProfile;
        },
    });
    const response = await handler(postRequest({
        name: 'Sam Driver',
        email: 'sam@example.com',
        licenceNo: 'D1234',
        vehicle: { make: 'Honda', model: 'Civic', year: 2022, plateNo: 'ABC 123' },
        policy: { policyNo: 'P-100', insurer: 'Acme', status: 'Active' },
    }, 'valid-token'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), savedProfile);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('save failure returns 503', async () => {
    const handler = createProfileSaveHandler(signedIn(), {
        saveProfile: async () => { throw new Error('database failure'); },
    });
    const response = await handler(postRequest(
        { name: 'Sam Driver', email: 'sam@example.com' },
        'valid-token',
    ));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'profile_unavailable' });
});

// Save validation tests

test('save without a name or an email is refused before any write, because the report requires both', async () => {
    let calls = 0;
    const handler = createProfileSaveHandler(signedIn(), {
        saveProfile: async () => { calls++; return savedProfile; },
    });
    for (const body of [
        { email: 'sam@example.com' },
        { name: 'Sam Driver' },
        { name: ' ', email: 'sam@example.com' },
    ]) {
        const response = await handler(postRequest(body, 'valid-token'));
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'invalid_profile' });
    }
    assert.equal(calls, 0);
});

test('save with a policy but no policy number is refused, because a policy is keyed by its number', async () => {
    let calls = 0;
    const handler = createProfileSaveHandler(signedIn(), {
        saveProfile: async () => { calls++; return savedProfile; },
    });
    const response = await handler(postRequest({
        name: 'Sam Driver',
        email: 'sam@example.com',
        policy: { insurer: 'Acme', status: 'Active' },
    }, 'valid-token'));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_profile' });
    assert.equal(calls, 0);
});

test('save with a malformed body is refused', async () => {
    const handler = createProfileSaveHandler(signedIn(), {
        saveProfile: async () => savedProfile,
    });
    const response = await handler(postRequest('not json', 'valid-token'));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_profile' });
});