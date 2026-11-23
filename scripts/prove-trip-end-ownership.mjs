// AB#99 proving test: only the owner's session can end a trip.
// Cross-device trip close check for the bug of 2026-11-05: a second device or
// another account cannot adopt or end someone else's Active trip.
// Node 24; no dependencies; uses only the public HTTP API (no database keys).
//
//   node scripts/prove-trip-end-ownership.mjs https://revolutioninsure-back-end.vercel.app
//
// Creates two new accounts (proving-99-a/b-<time>@example.com), records their
// consent (AB#106), and one trip for each. Passwords and tokens are generated
// here and never printed.
// Exit codes: 0 = every check passed; 1 = a check failed (file a Bug);
// 2 = setup failed (backend unreachable, sign-up refused...), not a product bug.

import { randomUUID } from 'node:crypto';

const arg = process.argv[2];
if (!arg) throw Error('Usage: node scripts/prove-trip-end-ownership.mjs <backend-url>');
const base = new URL(arg);
if (base.protocol !== 'https:') throw Error('Expected an HTTPS backend URL.');
// Paths below start with "/", which would silently drop any path on the URL.
if (base.pathname !== '/') throw Error('Pass the backend origin only, without a path.');

// Seconds plus a random suffix, so two runs at the same moment do not clash.
const stamp = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 6)}`;
const emailA = `proving-99-a-${stamp}@example.com`;
const emailB = `proving-99-b-${stamp}@example.com`;
const passwordA = `A-${randomUUID()}`;
const passwordB = `B-${randomUUID()}`;

async function call(path, { body, token, method } = {}) {
    const response = await fetch(new URL(path, base), {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(210_000),
        redirect: 'manual',
    });
    let json = null;
    try { json = await response.json(); } catch { /* non-JSON body */ }
    return { status: response.status, body: json };
}

// --- reporting ---------------------------------------------------------------

const results = [];
function section(title) { console.log(`\n${title}`); }
function check(id, description, passed, observed) {
    results.push({ id, description, passed });
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${id} ${description}  [${observed}]`);
}
const describe = r => `HTTP ${r.status}${r.body?.error ? ` ${r.body.error}` : ''}`;

class SetupError extends Error {}
function required(response, what) {
    if (response.status < 200 || response.status >= 300) {
        throw new SetupError(`${what}: ${describe(response)}`);
    }
    return response;
}
// Any failure that is not a check (setup step, timeout, unreachable backend)
// ends the run as "setup failed", never as a failed ownership check.
process.on('uncaughtException', error => {
    console.error(`\nSetup failed, not a product bug: ${error.message}`);
    process.exit(2);
});

async function newAccount(email, password) {
    const signUp = required(await call('/api/sign-up', { body: { email, password } }), `sign up ${email}`);
    const token = signUp.body.session.accessToken;
    required(await call('/api/consent', { method: 'POST', token }), `consent for ${email}`);
    return { userId: signUp.body.user.id, token };
}
const signIn = async (email, password) =>
    required(await call('/api/sign-in', { body: { email, password } }), `sign in ${email}`).body.session.accessToken;
const ownerSees = async (token, tripId) => call(`/api/trip-result?tripId=${tripId}`, { token });

// --- run -----------------------------------------------------------------------

console.log(`AB#99 proving test against ${base.origin}`);
console.log(`Run at ${new Date().toISOString()}`);
console.log(`Account A (owner): ${emailA}`);
console.log(`Account B (other): ${emailB}`);

const health = await call('/api/health');
if (health.status !== 200) throw Error(`Backend not healthy: ${describe(health)}`);

const a = await newAccount(emailA, passwordA);
const b = await newAccount(emailB, passwordB);

const startA = required(await call('/api/start-trip', { method: 'POST', token: a.token }), 'A starts a trip');
const trip = startA.body.trip.trip_id;
console.log(`A's Active trip: ${trip}`);

const now = Date.now();
const samples = [0, 1, 2, 3, 4].map(i => ({
    timestamp: new Date(now - (5 - i) * 1000).toISOString(),
    speed: 40 + i, acceleration: 0.2, latitude: 43.4643 + i * 0.0001, longitude: -80.5204,
}));

// 1. Another account cannot adopt A's Active trip -----------------------------
section('1. Another account cannot adopt the Active trip');

const startB = await call('/api/start-trip', { method: 'POST', token: b.token });
const tripB = startB.body?.trip?.trip_id;
check('1.1', 'B pressing Start does not get A\'s trip handed over as "your active trip"',
    startB.status === 201 && tripB !== undefined && tripB !== trip,
    `${describe(startB)}, B's trip: ${tripB ?? 'none'}${tripB === trip ? ' (A\'s trip!)' : ''}`);

const startBAgain = await call('/api/start-trip', { method: 'POST', token: b.token });
check('1.2', 'B pressing Start again is offered only B\'s own active trip',
    startBAgain.status === 409 && startBAgain.body?.trip?.trip_id === startB.body?.trip?.trip_id &&
        startBAgain.body?.trip?.trip_id !== trip,
    describe(startBAgain));

// 2. Another account cannot end, upload to, or read A's Active trip -----------
section('2. Another account cannot end (or touch) the Active trip');

const endB = await call('/api/end-trip', { token: b.token, body: { tripId: trip } });
check('2.1', 'B cannot end A\'s trip (same answer as a missing trip)',
    endB.status === 404 && endB.body?.error === 'trip_not_found', describe(endB));

const endBWithA = await call(`/api/end-trip?userId=${a.userId}`, { token: b.token, body: { tripId: trip, userId: a.userId } });
check('2.2', 'Adding A\'s user id to B\'s request does not let B end it', endBWithA.status === 404, describe(endBWithA));

const uploadB = await call('/api/upload-trip-samples', { token: b.token, body: { tripId: trip, samples } });
check('2.3', 'B cannot upload samples to A\'s trip', uploadB.status === 404, describe(uploadB));

const readB = await call(`/api/trip-result?tripId=${trip}`, { token: b.token });
check('2.4', 'B cannot read A\'s trip', readB.status === 404, describe(readB));

const afterB = await ownerSees(a.token, trip);
check('2.5', 'After all of B\'s attempts, A\'s trip is still Active (not ended by B)',
    afterB.status === 200 && afterB.body?.status === 'Active', `${describe(afterB)}, status ${afterB.body?.status ?? '-'}`);

// 3. Sessions that are not a signed-in owner cannot end it --------------------
section('3. Only a live owner session can end it');

const endNoToken = await call('/api/end-trip', { body: { tripId: trip } });
check('3.1', 'No token (a device that is not signed in) cannot end it', endNoToken.status === 401, describe(endNoToken));

const endFakeToken = await call('/api/end-trip', { token: 'not-a-real-token', body: { tripId: trip } });
check('3.2', 'A made-up token cannot end it', endFakeToken.status === 401, describe(endFakeToken));

// A device where A signed in and then signed out (Bug 89). The session is
// first shown to work, so the 401 afterwards proves sign-out revoked it.
const signedOutToken = await signIn(emailA, passwordA);
const beforeSignOut = await ownerSees(signedOutToken, trip);
const signOut = await call('/api/sign-out', { method: 'POST', token: signedOutToken });
const endSignedOut = await call('/api/end-trip', { token: signedOutToken, body: { tripId: trip } });
check('3.3', 'A device whose owner session was signed out cannot end it',
    beforeSignOut.status === 200 && signOut.status === 204 && endSignedOut.status === 401,
    `before sign-out ${describe(beforeSignOut)}, sign-out ${describe(signOut)}, end ${describe(endSignedOut)}`);

const stillActive = await ownerSees(a.token, trip);
check('3.4', 'A\'s trip is still Active after those attempts',
    stillActive.status === 200 && stillActive.body?.status === 'Active', `status ${stillActive.body?.status ?? '-'}`);

// 4. The owner, on a second device, may pick up and end their own trip --------
section('4. Control: the owner\'s own second device (same account) may adopt and end it');

const secondDevice = await signIn(emailA, passwordA);
const adoptOwn = await call('/api/start-trip', { method: 'POST', token: secondDevice });
check('4.1', 'A on a second device is offered A\'s own Active trip (recovery after a restart)',
    adoptOwn.status === 409 && adoptOwn.body?.error === 'active_trip_exists' && adoptOwn.body?.trip?.trip_id === trip,
    describe(adoptOwn));

const uploadOwn = await call('/api/upload-trip-samples', { token: a.token, body: { tripId: trip, samples } });
check('4.2', 'The owner can upload to their own trip', uploadOwn.status === 201, describe(uploadOwn));

// Ownership is what this story proves: the owner's End must get past the
// ownership check (not 401/404). Scoring after that (speed limits, scoring
// config) is out of scope here, so a scoring hiccup is reported, not failed.
const endOwn = await call('/api/end-trip', { token: secondDevice, body: { tripId: trip } });
check('4.3', 'The owner is allowed to end it from the second device',
    endOwn.status !== 401 && endOwn.status !== 404,
    `${describe(endOwn)}${endOwn.status === 200 ? '' : ' (allowed; scoring did not finish)'}`);

const endBAfter = await call('/api/end-trip', { token: b.token, body: { tripId: trip } });
check('4.4', 'B still cannot end it afterwards', endBAfter.status === 404, describe(endBAfter));

// Tidy up: end B's own trip so B is not left with an Active trip.
if (tripB) {
    const tidy = await call('/api/end-trip', { token: b.token, body: { tripId: tripB } });
    console.log(`\nTidy-up: ended B's own trip: ${describe(tidy)}`);
}

// --- summary -------------------------------------------------------------------

const failed = results.filter(r => !r.passed);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} checks passed.`);
for (const r of failed) console.log(`  FAIL: ${r.id} ${r.description}`);
if (failed.length) console.log('\nA check failed: file a Bug (AB#99 acceptance).');
process.exitCode = failed.length ? 1 : 0;
