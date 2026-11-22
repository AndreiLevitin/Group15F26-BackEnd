// Node 24. Real production scoring, deterministic inputs; no API/DB writes.
import { writeFileSync } from 'node:fs';
import { calculateTripScore } from '../src/services/trip-scoring.ts';
import { calculateTripDistanceKm } from '../src/services/trip-distance.ts';
import { loadTripScoringConfig } from '../src/config/trip-scoring-config.ts';
import { tripTestCases, generateTripPoints } from './trip-test-cases.mjs';
const args = process.argv.slice(2);
if (args.length > 1 || args[0]?.startsWith('-')) throw Error('Usage: node scripts/test-trip-scores.mjs [report.json]');
// Expected values are for agreed defaults, independent of machine-specific env.
const config = loadTripScoringConfig({});
const reports = [];
for (const scenario of tripTestCases) {
    const samples = generateTripPoints(scenario).map((p,i) => ({
        sample_id:`${scenario.name}-${i}`, trip_id:scenario.name,
        recorded_at:new Date(Date.UTC(2026,10,13,12) + p.elapsedSeconds * 1000).toISOString(),
        latitude:p.latitude, longitude:p.longitude, speed_kmh:p.speed, road_speed_limit_kmh:p.speedLimitKmh,
    }));
    const input = { tripId:scenario.name, distanceKm:calculateTripDistanceKm(samples), samples };
    const result = calculateTripScore(input, config);
    const passed = result.score === scenario.expectedScore &&
        (scenario.expectedReason === undefined || result.reason === scenario.expectedReason);
    reports.push({ name:scenario.name, expectedScore:scenario.expectedScore,
        expectedReason:scenario.expectedReason ?? null, passed, input, result });
}
console.table(reports.map(r => ({ scenario:r.name, points:r.input.samples.length,
    distanceKm:Number(r.input.distanceKm?.toFixed(3)), expected:r.expectedScore ?? 'Unscored',
    actual:r.result.score ?? 'Unscored', reason:r.result.reason ?? '',
    evaluatedSeconds:r.result.quality.evaluatedSeconds, result:r.passed ? 'PASS' : 'FAIL' })));
console.log(`${reports.filter(r => r.passed).length}/${reports.length} passed. Offline scoring, no DB trips created.`);
if (args[0]) writeFileSync(args[0], JSON.stringify({ mode:'offline', config, reports }, null, 2) + '\n');
if (reports.some(r => !r.passed)) process.exitCode = 1;
