// Offline replay of the exported trip CSV. Does not call APIs or write to the DB.
// Node 24. Output includes full sample/interval audit; original CSV is never modified.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { calculateTripScore } from '../src/services/trip-scoring.ts';
import { calculateTripDistanceKm } from '../src/services/trip-distance.ts';
import { createTripScoringConfig } from '../src/config/trip-scoring-config.ts';
if (!process.argv[2]) throw Error('Usage: node scripts/replay-band-scoring.mjs <trip.csv> [audit.json] [config.json]');
const source = readFileSync(process.argv[2]);
// CSV quoted fields, escaped quotes and CRLF are supported. Reject malformed input.
function parseCsv(text) {
    const rows = []; let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            if (quoted && text[i + 1] === '"') { field += '"'; i++; }
            else quoted = !quoted;
        } else if (!quoted && (c === ',' || c === '\n')) {
            row.push(field.replace(/\r$/, '')); field = '';
            if (c === '\n') { rows.push(row); row = []; }
        } else field += c;
    }
    if (quoted) throw Error('Unclosed CSV quote.');
    if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
    return rows;
}
const [header, ...rows] = parseCsv(source.toString('utf8').replace(/^\uFEFF/, ''));
const required = ['sample_id','recorded_at','latitude','longitude','actual_speed_kmh','road_limit_kmh'];
if (required.some(key => !header.includes(key))) throw Error('Expected exported trip CSV columns.');
const number = value => value === 'null' || value === '' ? null : Number(value);
const samples = rows.filter(r => r.length > 1).map(row => {
    if (row.length !== header.length) throw Error('Unexpected CSV field count.');
    const r = Object.fromEntries(header.map((h,i) => [h,row[i]]));
    return { sample_id:r.sample_id, trip_id:'offline-replay',
        recorded_at:r.recorded_at.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'),
        latitude:number(r.latitude), longitude:number(r.longitude),
        speed_kmh:number(r.actual_speed_kmh), road_speed_limit_kmh:number(r.road_limit_kmh) };
}).filter(r => r.latitude !== null && r.longitude !== null);
const config = createTripScoringConfig(JSON.parse(readFileSync(process.argv[4] ??
    new URL('../docs/scoring-config.example.json', import.meta.url), 'utf8')));
const distanceKm = calculateTripDistanceKm(samples);
const result = calculateTripScore({ tripId:'offline-replay', distanceKm, samples }, config);
const output = { csvSha256:createHash('sha256').update(source).digest('hex'), config, distanceKm, result };
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ csvSha256:output.csvSha256, gpsSamples:samples.length, version:result.scoringVersion,
    score:result.score, exactScore:result.quality.evaluatedSeconds > 0 ? result.quality.weightedScore/result.quality.evaluatedSeconds : null,
    distanceKm, quality:result.quality }, null, 2));
