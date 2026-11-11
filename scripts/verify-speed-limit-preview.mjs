// Node 24; no dependencies. Creates one test trip on the supplied Preview backend.
// Does not access credentials, modify existing trips or infer DB enrichment from a score.
import { readFileSync } from 'node:fs';

const arg = process.argv[2];
if (!arg) throw Error('Usage: node scripts/verify-speed-limit-preview.mjs <preview-url> [courseTrip.json]');
const base = new URL(arg);
if (base.protocol !== 'https:' || !base.hostname.endsWith('.vercel.app')) {
    throw Error('Expected an HTTPS Vercel Preview URL.');
}
const rows = JSON.parse(readFileSync(process.argv[3] ??
    new URL('../../RevolutionInsure-front-end/src/demo/courseTrip.json', import.meta.url), 'utf8'));
if (!Array.isArray(rows) || !rows.length || rows.some(r => !Array.isArray(r) || r.length !== 4 ||
    r.some(v => typeof v !== 'number' || !Number.isFinite(v)))) throw Error('Invalid course fixture.');

async function request(path, body) {
    const response = await fetch(new URL(path, base), {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(210000),
        redirect: 'manual',
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch {
        throw Error(`${path}: HTTP ${response.status}, non-JSON response (check deployment protection/runtime logs).`);
    }
    if (!response.ok) {
        // Do not dump server bodies or any pre-existing active trip.
        throw Error(`${path}: HTTP ${response.status}, ${result.error ?? 'request failed'}`);
    }
    return result;
}

let tripId;
try {
    console.log('health:', JSON.stringify(await request('/api/health')));
    const started = await request('/api/start-trip', {});
    tripId = started.trip?.trip_id;
    if (typeof tripId !== 'string') throw Error('start-trip did not return a trip ID.');
    console.log('Created test trip:', tripId);
    // The course CSV has no timezone. Simulate absolute timestamps ending now,
    // preserving its elapsed intervals, as the app Fake trip feature does.
    const start = Date.now() - rows.at(-1)[0];
    const samples = rows.map(([elapsedMs, latitude, longitude, speed], i) => {
        const previous = rows[i - 1];
        const seconds = previous ? (elapsedMs - previous[0]) / 1000 : 0;
        return { timestamp: new Date(start + elapsedMs).toISOString(), latitude, longitude, speed,
            acceleration: seconds > 0 ? (speed - previous[3]) / 3.6 / seconds : 0 };
    });
    console.log('upload:', JSON.stringify(await request('/api/upload-trip-samples', { tripId, samples })));
    const first = await request('/api/end-trip', { tripId });
    console.log('end-trip:', JSON.stringify(first));
    if (first.trip?.status !== 'Completed') throw Error('Trip did not reach Completed.');
    const repeated = await request('/api/end-trip', { tripId });
    if (JSON.stringify(first) !== JSON.stringify(repeated)) throw Error('Repeated end-trip changed the stored result.');
    console.log('Repeated end-trip returned the same result.');
    console.log('trip-result:', JSON.stringify(await request(`/api/trip-result?tripId=${encodeURIComponent(tripId)}`)));
    console.log('API flow passed. Verify stored enrichment with the SQL below; Completed alone does not prove the switch was enabled.');
    console.log(`SELECT count(*) AS gps_samples,
  count(l.sample_id) AS enriched_samples,
  count(*) FILTER (WHERE l.lookup_status = 'available') AS with_limit,
  count(*) FILTER (WHERE l.lookup_status IN ('missing', 'unmatched', 'insufficient_trace')) AS without_limit,
  array_agg(DISTINCT l.provider) AS providers,
  min(l.fetched_at) AS first_fetch, max(l.fetched_at) AS last_fetch
FROM public.trip_data_points d
LEFT JOIN public.trip_sample_speed_limits l USING (sample_id, trip_id)
WHERE d.trip_id = '${tripId}' AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL;`);
} catch (error) {
    console.error(error instanceof Error ? error.message : 'Preview verification failed.');
    if (tripId) console.error(`Created test trip: ${tripId}. Inspect its state before retrying; do not overwrite its raw samples.`);
    process.exitCode = 1;
}
