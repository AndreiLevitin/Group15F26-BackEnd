// AB#77 review: a Supabase 429 is a temporary rate limit, never an invalid
// token or session, even though it falls in the 400–499 range.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    expectedFailure,
    refreshFailure,
    tokenCheckFailure,
} from '../src/repositories/auth-error-mapping.ts';

const rateLimits = [
    { status: 429, code: 'over_request_rate_limit' },
    { status: 429 },                                  // status without the code
    { status: 429, code: 'some_new_limit_code' },     // unknown code
    { code: 'over_request_rate_limit' },              // code without a status
];

test('token checks treat every form of 429 as rate limited, not invalid', () => {
    for (const error of rateLimits) assert.equal(tokenCheckFailure(error), 'rate_limited', JSON.stringify(error));
});

test('refresh treats every form of 429 as rate limited, never as an unusable refresh token', () => {
    for (const error of rateLimits) assert.equal(refreshFailure(error), 'rate_limited', JSON.stringify(error));
});

test('sign-in and sign-up treat every form of 429 as rate limited', () => {
    for (const error of rateLimits) assert.equal(expectedFailure(error), 'rate_limited', JSON.stringify(error));
});

test('other 4xx answers on a token check still mean the token is invalid', () => {
    for (const status of [400, 401, 403, 404]) {
        assert.equal(tokenCheckFailure({ status, code: 'bad_jwt' }), 'invalid');
    }
});

test('other 4xx answers on refresh still mean the refresh token cannot be used', () => {
    assert.equal(refreshFailure({ status: 400, code: 'refresh_token_already_used' }), 'invalid_refresh_token');
    assert.equal(refreshFailure({ status: 400, code: 'something_else' }), 'invalid_refresh_token');
});

test('server errors and missing statuses are "unavailable", not invalid', () => {
    for (const error of [{ status: 500 }, { status: 503 }, {}]) {
        assert.equal(tokenCheckFailure(error), 'unavailable');
        assert.equal(refreshFailure(error), null);
    }
});
