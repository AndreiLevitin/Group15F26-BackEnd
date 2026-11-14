// AB#78 proving test: story 69 account isolation, run against a live backend.
// Node 24; no dependencies; uses only the public HTTP API (no database keys).
//
//   node scripts/prove-account-isolation.mjs https://revolutioninsure-back-end.vercel.app
//
// Creates two new accounts (proving-78-a/b-<time>@example.com) and one trip
// for each. Passwords and tokens are generated here and never printed.
// Exit code 0 = every criterion met; 1 = at least one check failed.

import { randomUUID } from 'node:crypto';

const arg = process.argv[2];
if (!arg) throw Error('Usage: node scripts/prove-account-isolation.mjs <backend-url>');
const base = new URL(arg);
if (base.protocol !== 'https:') throw Error('Expected an HTTPS backend URL.');

const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const emailA = `proving-78-a-${stamp}@example.com`;
const emailB = `proving-78-b-${stamp}@example.com`;
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
let currentCriterion = '';
function criterion(title) {
    currentCriterion = title;
    console.log(`\n${title}`);
}
function check(id, description, passed, observed, { knownBug = false } = {}) {
    const verdict = passed ? 'PASS' : knownBug ? 'FAIL (known bug)' : 'FAIL';
    results.push({ criterion: currentCriterion, id, description, verdict, observed });
    console.log(`  ${verdict.padEnd(16)} ${id} ${description}  [${observed}]`);
}
const describe = r => `HTTP ${r.status}${r.body?.error ? ` ${r.body.error}` : ''}`;
const hasSession = r => Boolean(r.body?.session?.accessToken);

// --- run -----------------------------------------------------------------------

console.log(`AB#78 proving test against ${base.origin}`);
console.log(`Run at ${new Date().toISOString()}`);
console.log(`Account A: ${emailA}`);
console.log(`Account B: ${emailB}`);

const health = await call('/api/health');
if (health.status !== 200) throw Error(`Backend not healthy: ${describe(health)}`);

// 1. Duplicate email fails and creates no second account ----------------------
criterion('1. Duplicate email fails and creates no second account');

const signUpA = await call('/api/sign-up', { body: { email: emailA, password: passwordA } });
check('1.1', 'Sign up account A', signUpA.status === 201 && hasSession(signUpA), describe(signUpA));
if (signUpA.status !== 201) throw Error('Cannot continue without account A.');
const userA = signUpA.body.user.id;
let tokenA = signUpA.body.session.accessToken;

const dupSame = await call('/api/sign-up', { body: { email: emailA, password: passwordA } });
check('1.2', 'Sign up again with the same email and password is refused',
    dupSame.status === 409 && dupSame.body?.error === 'email_already_registered' && !hasSession(dupSame),
    describe(dupSame));

const otherPassword = `X-${randomUUID()}`;
const dupOther = await call('/api/sign-up', { body: { email: emailA, password: otherPassword } });
check('1.3', 'Sign up again with the same email and a new password is refused',
    dupOther.status === 409 && dupOther.body?.error === 'email_already_registered' && !hasSession(dupOther),
    describe(dupOther));

const dupCase = await call('/api/sign-up', { body: { email: emailA.toUpperCase(), password: otherPassword } });
check('1.4', 'Same email in different letter case is refused too',
    dupCase.status === 409 && !hasSession(dupCase), describe(dupCase));

const signInOther = await call('/api/sign-in', { body: { email: emailA, password: otherPassword } });
check('1.5', 'The refused sign-up\'s password does not sign in (nothing was created or replaced)',
    signInOther.status === 401 && !hasSession(signInOther), describe(signInOther));

const signInA = await call('/api/sign-in', { body: { email: emailA, password: passwordA } });
check('1.6', 'Original password still signs in to the same single account',
    signInA.status === 200 && signInA.body?.user?.id === userA,
    `${describe(signInA)}, same user id: ${signInA.body?.user?.id === userA}`);
let refreshA = signUpA.body.session.refreshToken;
if (signInA.status === 200) {
    tokenA = signInA.body.session.accessToken;
    refreshA = signInA.body.session.refreshToken;
}

// 2. Wrong password fails -----------------------------------------------------
criterion('2. Wrong password fails');

const wrong = await call('/api/sign-in', { body: { email: emailA, password: `${passwordA}-wrong` } });
check('2.1', 'Wrong password is refused with no session',
    wrong.status === 401 && wrong.body?.error === 'invalid_credentials' && !hasSession(wrong), describe(wrong));

const unknown = await call('/api/sign-in', { body: { email: `nobody-${stamp}@example.com`, password: passwordA } });
check('2.2', 'Unknown email gets the identical answer (does not reveal which emails exist)',
    unknown.status === 401 && unknown.body?.error === wrong.body?.error &&
        unknown.body?.message === wrong.body?.message && !hasSession(unknown),
    describe(unknown));

// 3. A second account receives none of the first account's trips -------------
criterion('3. A second account receives none of the first account\'s trips from the backend');

let startA = await call('/api/start-trip', { method: 'POST', token: tokenA });
if (startA.status === 409 && startA.body?.trip) startA = { status: 201, body: { trip: startA.body.trip } };
check('3.1', 'Account A starts a trip', startA.status === 201, describe(startA));
if (startA.status !== 201) throw Error('Cannot continue without a trip for account A.');
const tripA = startA.body.trip.trip_id;

const signUpB = await call('/api/sign-up', { body: { email: emailB, password: passwordB } });
check('3.2', 'Sign up account B', signUpB.status === 201 && signUpB.body?.user?.id !== userA, describe(signUpB));
if (signUpB.status !== 201) throw Error('Cannot continue without account B.');
const tokenB = signUpB.body.session.accessToken;

const bResultActive = await call(`/api/trip-result?tripId=${tripA}`, { token: tokenB });
check('3.3', 'B cannot read A\'s active trip (same answer as a missing trip)',
    bResultActive.status === 404 && bResultActive.body?.error === 'trip_not_found', describe(bResultActive));

const now = Date.now();
const samples = [0, 1, 2, 3, 4].map(i => ({
    timestamp: new Date(now - (5 - i) * 1000).toISOString(),
    speed: 40 + i, acceleration: 0.2, latitude: 43.4643 + i * 0.0001, longitude: -80.5204,
}));
const bUpload = await call('/api/upload-trip-samples', { token: tokenB, body: { tripId: tripA, samples } });
check('3.4', 'B cannot upload samples to A\'s trip', bUpload.status === 404, describe(bUpload));

const bEnd = await call('/api/end-trip', { token: tokenB, body: { tripId: tripA } });
check('3.5', 'B cannot end (or trigger scoring of) A\'s trip', bEnd.status === 404, describe(bEnd));

const bTamper = await call(`/api/trip-result?tripId=${tripA}&userId=${userA}`, { token: tokenB });
check('3.6', 'Adding A\'s user id to the request does not give B access', bTamper.status === 404, describe(bTamper));

const bStart = await call('/api/start-trip', { method: 'POST', token: tokenB });
check('3.7', 'B starting a trip gets a new trip of B\'s own, not A\'s active trip',
    bStart.status === 201 && bStart.body?.trip?.trip_id !== tripA,
    `${describe(bStart)}, different trip: ${bStart.body?.trip?.trip_id !== tripA}`);

const aUpload = await call('/api/upload-trip-samples', { token: tokenA, body: { tripId: tripA, samples } });
check('3.8', 'Control: A can upload to A\'s own trip', aUpload.status === 201, describe(aUpload));

const aEnd = await call('/api/end-trip', { token: tokenA, body: { tripId: tripA } });
check('3.9', 'Control: A can end A\'s own trip', aEnd.status === 200 || aEnd.status === 409, describe(aEnd));

const bResultEnded = await call(`/api/trip-result?tripId=${tripA}`, { token: tokenB });
check('3.10', 'B still cannot read A\'s trip after it has ended and been scored',
    bResultEnded.status === 404, describe(bResultEnded));

const aResult = await call(`/api/trip-result?tripId=${tripA}`, { token: tokenA });
check('3.11', 'Control: A can read A\'s own trip result',
    aResult.status === 200 && aResult.body?.tripId === tripA,
    `${describe(aResult)}, status ${aResult.body?.status ?? '-'}`);

if (bStart.status === 201) {
    const bOwnEnd = await call('/api/end-trip', { token: tokenB, body: { tripId: bStart.body.trip.trip_id } });
    const aOnB = await call(`/api/trip-result?tripId=${bStart.body.trip.trip_id}`, { token: tokenA });
    check('3.12', 'Reverse direction: A cannot read B\'s trip',
        aOnB.status === 404, `${describe(aOnB)} (B's trip ended: ${describe(bOwnEnd)})`);
}

// 4. Signing out clears access until someone signs in again -------------------
criterion('4. Signing out clears access until someone signs in again');

const noToken = await call(`/api/trip-result?tripId=${tripA}`);
check('4.1', 'With no token (the app after sign-out) the backend gives no trip data',
    noToken.status === 401 && noToken.body?.error === 'unauthorized', describe(noToken));

const badToken = await call(`/api/trip-result?tripId=${tripA}`, { token: 'not-a-real-token' });
check('4.2', 'A made-up token gives no trip data', badToken.status === 401, describe(badToken));

// Sign A out the way the app does: tell the backend, then drop the tokens.
// Before bug 89 the endpoint does not exist (404) and the app only dropped
// its tokens locally, so the old tokens kept working.
const signOut = await call('/api/sign-out', { method: 'POST', token: tokenA });
const bug89 = { knownBug: signOut.status === 404 };
check('4.3', 'A signs out through the backend',
    signOut.status === 204, `${describe(signOut)}${signOut.status === 404 ? ' — no sign-out endpoint (bug 89)' : ''}`, bug89);

const oldToken = await call(`/api/trip-result?tripId=${tripA}`, { token: tokenA });
check('4.4', 'A\'s access token from before sign-out no longer works on the backend',
    oldToken.status === 401, describe(oldToken), bug89);

const oldRefresh = await call('/api/refresh-session', { body: { refreshToken: refreshA } });
check('4.5', 'A\'s refresh token from before sign-out can no longer mint a new session',
    oldRefresh.status === 401 && !hasSession(oldRefresh), describe(oldRefresh), bug89);

const again = await call('/api/sign-in', { body: { email: emailA, password: passwordA } });
const restored = again.status === 200
    ? await call(`/api/trip-result?tripId=${tripA}`, { token: again.body.session.accessToken })
    : again;
check('4.6', 'Signing in again restores access to A\'s own trip',
    restored.status === 200 && restored.body?.tripId === tripA, describe(restored));

// --- summary -------------------------------------------------------------------

const failed = results.filter(r => r.verdict !== 'PASS');
console.log(`\nSummary: ${results.length - failed.length}/${results.length} checks passed.`);
for (const r of failed) console.log(`  ${r.verdict}: ${r.id} ${r.description}`);
console.log(`\nDatabase check for criterion 1 (run in the Supabase SQL editor, expect 1):`);
console.log(`  SELECT count(*) FROM auth.users WHERE lower(email) = '${emailA}';`);
process.exitCode = failed.length ? 1 : 0;
