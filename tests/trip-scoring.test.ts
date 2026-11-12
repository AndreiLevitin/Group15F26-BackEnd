import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTripScore, type TripScoringInput } from '../src/services/trip-scoring.ts';
import { createTripScoringConfig } from '../src/config/trip-scoring-config.ts';
export const config = createTripScoringConfig({ minValidReadings: 5, minDistanceKm: 0.1,
    toleranceKmh: 5, maxIntervalSeconds: 3, minMovingSpeedKmh: 5,
    bands: [{ fromKmh: 0, score: 80 }, { fromKmh: 16, score: 60 }, { fromKmh: 30, score: 40 }, { fromKmh: 50, score: 0 }] });
function makeTrip(speeds: readonly (number | null)[], times = speeds.map((_, i) => i), limits = speeds.map((): number | null => 50)): TripScoringInput {
    return { tripId: 'trip', distanceKm: 0.3, samples: speeds.map((speed, i) => ({
        sample_id: `s${i}`, trip_id: 'trip', recorded_at: new Date(Date.UTC(2026, 10, 12) + times[i]! * 1000).toISOString(),
        latitude: 43, longitude: -80, speed_kmh: speed, road_speed_limit_kmh: limits[i]!,
    })) };
}
test('constant excess produces its band score independent of trip length', () => {
    for (const [excess, score] of [[0,100],[5,100],[5.001,80],[15.999,80],[16,60],[29.999,60],[30,40],[49.999,40],[50,0],[100,0]]) {
        for (const distanceKm of [0.1, 20, 800]) {
            const r = calculateTripScore({ ...makeTrip(Array(5).fill(50 + excess!)), distanceKm }, config);
            assert.equal(r.score, score, `excess ${excess}`);
            assert.equal(r.quality.evaluatedSeconds, 4);
        }
    }
});
test('uses endpoint average and actual durations; hand calculation for trip shorter than 0.5 km', () => {
    // Scores 100,80,60,40,0; durations .5,1,2,1 => (45+70+100+20)/4.5.
    const r = calculateTripScore(makeTrip([55,60,70,85,100], [0,.5,1.5,3.5,4.5]), config);
    assert.equal(r.score, 52);
    assert.equal(r.quality.weightedScore, 235);
    assert.equal(r.quality.evaluatedSeconds, 4.5);
    assert.equal(r.quality.timeByScore.reduce((n, b) => n + b.seconds, 0), 4.5);
    assert.equal(r.scoringStatus, 'Scored');
});
test('time weighting is independent of additional readings in a constant-speed interval', () => {
    const cfg = { ...config, minValidReadings: 2 };
    const a = calculateTripScore(makeTrip([60,60,85,85], [0,2,3,5]), cfg);
    const b = calculateTripScore(makeTrip([60,60,60,85,85,85], [0,1,2,3,4,5]), cfg);
    assert.equal(a.quality.weightedScore, b.quality.weightedScore);
    assert.equal(a.score, b.score);
});
test('unknown limits are excluded, never assumed safe or scored against 85', () => {
    const r = calculateTripScore(makeTrip([60,60,60,60,60,60,160], undefined, [50,50,50,50,50,null,null]), config);
    assert.equal(r.score, 80);
    assert.equal(r.quality.evaluatedReadings, 5);
    assert.equal(r.quality.unknownLimitSeconds, 2);
    assert.equal(r.quality.coveragePercent, 100 * 4 / 6);
    assert.ok(r.sampleDecisions.every(d => d.usedFallback !== true));
    assert.equal(r.sampleDecisions[5]!.status, 'excluded');
    const unknown = calculateTripScore(makeTrip([60,60,60,60,60], undefined, [null,null,null,null,null]), config);
    assert.equal(unknown.score, null);
    assert.equal(unknown.scoringStatus === 'Unscored' && unknown.reason, 'NO_EVALUATED_INTERVALS');
});
test('minimum readings counts only endpoints participating in eligible intervals', () => {
    const r = calculateTripScore(makeTrip([60,60,60,60,60], undefined, [50,50,50,50,null]), config);
    assert.equal(r.score, null);
    assert.equal(r.quality.evaluatedReadings, 4);
    assert.ok(r.sampleDecisions.every(d => d.status !== 'used'));
});
test('gaps are excluded instead of carrying speed; events restart after a gap', () => {
    const r = calculateTripScore(makeTrip([60,60,60,60,60,60], [0,1,2,10,11,12]), config);
    assert.equal(r.score, 80);
    assert.equal(r.quality.gpsGapSeconds, 8);
    assert.equal(r.quality.evaluatedSeconds, 4);
    assert.equal(r.scoringStatus === 'Scored' && r.speedingEvents, 2);
    const boundary = calculateTripScore(makeTrip([60,60,60,60,60], [0,3,6,9,12]), config);
    assert.equal(boundary.quality.evaluatedSeconds, 12);
});
test('stationary time is excluded, zero speed remains a valid reading', () => {
    const r = calculateTripScore(makeTrip([0,0,0,0,0,60,60,60,60,60]), config);
    assert.equal(r.validReadings, 10);
    assert.equal(r.quality.stationarySeconds, 4);
    assert.equal(r.quality.evaluatedSeconds, 5);
    assert.equal(r.score, 82);
});
test('invalid GPS and missing speeds do not bridge neighboring intervals', () => {
    const trip = makeTrip([60,60,null,60,60,60,60]);
    const r = calculateTripScore(trip, config);
    assert.equal(r.ignoredReadings, 1);
    assert.equal(r.quality.invalidEndpointSeconds, 2);
    assert.equal(r.quality.evaluatedSeconds, 4);
    assert.equal(r.score, 80);
    const invalid = { ...trip, samples: trip.samples.map((s,i) => i === 2 ? { ...s, speed_kmh: 60, latitude: 91 } : s) };
    assert.equal(calculateTripScore(invalid, config).quality.invalidEndpointSeconds, 2);
});
test('duplicates keep highest speed with its own limit; input order cannot affect result', () => {
    const trip = makeTrip([60,60,60,60,60]);
    const extra = { ...trip.samples[0]!, sample_id: 'higher', speed_kmh: 65, road_speed_limit_kmh: 60 };
    for (const samples of [[...trip.samples,extra], [extra,...trip.samples].reverse()]) {
        const r = calculateTripScore({ ...trip, samples }, config);
        assert.equal(r.duplicateTimestampReadings, 1);
        assert.equal(r.validReadings, 5);
        assert.equal(r.sampleDecisions.find(d => d.sampleId === 'higher')!.readingScore, 100);
        assert.equal(r.score, 83);
    }
    const tie = { ...trip.samples[0]!, sample_id: 'a', road_speed_limit_kmh: 60 };
    assert.equal(calculateTripScore({ ...trip, samples: [...trip.samples,tie] }, config).score, 83);
});
test('tolerance is applied once, bands use excess above posted limit', () => {
    const r = calculateTripScore(makeTrip([66,66,66,66,66]), { ...config, toleranceKmh: 7 });
    assert.equal(r.score, 60); // +16, not +9 after subtracting tolerance again.
    assert.equal(r.sampleDecisions[0]!.thresholdKmh, 57);
});
test('only an entirely zero-rated evaluated trip displays zero', () => {
    const r = calculateTripScore(makeTrip([99,100,100,100,100], [0,.001,1.001,2.001,3.001]), config);
    assert.equal(r.score, 1);
    assert.ok(r.quality.weightedScore > 0);
});
test('minimum distance is inclusive; missing/invalid/short distance is unscored', () => {
    const trip = makeTrip([60,60,60,60,60]);
    assert.equal(calculateTripScore({ ...trip, distanceKm: .1 }, config).score, 80);
    for (const distanceKm of [null,0,-1,NaN,Infinity,.099]) {
        const r = calculateTripScore({ ...trip, distanceKm }, config);
        assert.equal(r.score, null);
        assert.ok(r.sampleDecisions.every(d => d.status !== 'used'));
    }
});
test('bad identities and malformed stored limits cannot produce a score', () => {
    const trip = makeTrip([60,60,60,60,60]);
    assert.equal(calculateTripScore({ ...trip, tripId: 'other' }, config).score, null);
    assert.throws(() => calculateTripScore({ ...trip, samples: [...trip.samples,trip.samples[0]!] }, config));
    for (const limit of [0,-1,NaN,Infinity]) {
        assert.throws(() => calculateTripScore({ ...trip, samples: trip.samples.map(s => ({ ...s, road_speed_limit_kmh: limit })) }, config));
    }
});
test('config rejects unordered bands, increasing scores, invalid intervals and ambiguous tolerance', () => {
    for (const bands of [[], [{fromKmh:0,score:80}], [{fromKmh:0,score:80},{fromKmh:16,score:90}],
        [{fromKmh:0,score:80},{fromKmh:0,score:60}], [{fromKmh:0,score:80},{fromKmh:16,score:-1}]]) {
        assert.throws(() => createTripScoringConfig({ ...config, bands }));
    }
    assert.throws(() => createTripScoringConfig({ ...config, toleranceKmh:16 }));
    assert.throws(() => createTripScoringConfig({ ...config, maxIntervalSeconds:0 }));
});

test('coverage is retained as quality, not an additional unapproved minimum gate', () => {
    const limits: (number | null)[] = [50,50,50,50,50,...Array(95).fill(null)];
    const r = calculateTripScore(makeTrip(Array(100).fill(60), undefined, limits), config);
    assert.equal(r.score, 80);
    assert.equal(r.quality.evaluatedReadings, 5);
    assert.equal(r.quality.coveragePercent, 100 * 4 / 99);
});
test('malformed times and negative speeds are counted as ignored, never as safe driving', () => {
    const trip = makeTrip(Array(7).fill(60));
    trip.samples[0]!.recorded_at = 'invalid';
    trip.samples[1]!.speed_kmh = -1;
    const r = calculateTripScore(trip, config);
    assert.equal(r.score, 80);
    assert.equal(r.ignoredReadings, 2);
    assert.equal(r.quality.evaluatedReadings, 5);
});
test('long traces retain one decision per sample and one interval per adjacent pair', () => {
    const r = calculateTripScore(makeTrip(Array(40000).fill(60)), config);
    assert.equal(r.score, 80);
    assert.equal(r.sampleDecisions.length, 40000);
    assert.equal(r.intervalDecisions.length, 39999);
    assert.equal(r.quality.evaluatedSeconds, 39999);
});
