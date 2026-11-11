import assert from "node:assert/strict";
import test from "node:test";
import { createTripScoringConfig } from "../src/config/trip-scoring-config.ts";
import { calculateTripScore } from "../src/services/trip-scoring.ts";
import type { TripScoringInput } from "../src/services/trip-scoring.ts";

// Example values for tests only — not approved production settings.
const config = createTripScoringConfig({
    minValidReadings: 5,
    minDistanceKm: 0.1,
    speedingPenaltyPerEvent: 2,
    toleranceKmh: 5,
    fallbackThresholdKmh: 85,
});

function makeTrip(
    speeds: readonly (number | null)[],
    distanceKm = 1,
): TripScoringInput {
    return {
        tripId: "test-trip",
        distanceKm,
        samples: speeds.map((speed, index) => ({
            sample_id: `sample-${index}`,
            trip_id: "test-trip",
            recorded_at: new Date(
                Date.UTC(2026, 8, 12, 15, 0, index),
            ).toISOString(),
            latitude: 43.4,
            longitude: -80.5,
            speed_kmh: speed,
            road_speed_limit_kmh: null,
        })),
    };
}

test("no speeding gives 100; zero speed is valid", () => {
    const result = calculateTripScore(
        makeTrip([0, 45, 60, 80, 85]),
        config,
    );

    assert.equal(result.scoringStatus, "Scored");
    assert.equal(result.score, 100);
    assert.equal(result.validReadings, 5);
});

test("continuous speeding counts as one event", () => {
    const result = calculateTripScore(
        makeTrip([85, 85.01, 90, 95, 85]),
        config,
    );

    assert.ok(result.scoringStatus === "Scored");
    assert.equal(result.speedingEvents, 1);
    assert.equal(result.score, 98);
});

test("a normal reading separates speeding events", () => {
    const result = calculateTripScore(
        makeTrip([90, 95, 85, 90, 80]),
        config,
    );

    assert.ok(result.scoringStatus === "Scored");
    assert.equal(result.speedingEvents, 2);
    assert.equal(result.score, 96);
});

test("penalties are divided by distance and rounded", () => {
    const result = calculateTripScore(
        makeTrip([90, 80, 90, 80, 80], 5),
        config,
    );

    // 100 - (2 events * 2) / 5 = 99.2, rounded to 99.
    assert.equal(result.score, 99);
});

test("a trip under 1 km can receive a score", () => {
    const result = calculateTripScore(
        makeTrip([90, 80, 80, 80, 80], 0.5),
        config,
    );

    assert.equal(result.scoringStatus, "Scored");
    assert.equal(result.score, 96);
});

test("large penalties produce a real zero score", () => {
    const result = calculateTripScore(
        makeTrip([90, 80, 90, 80, 90], 0.1),
        { ...config, speedingPenaltyPerEvent: 5 },
    );

    assert.equal(result.scoringStatus, "Scored");
    assert.equal(result.score, 0);
});

test("too few readings return Unscored", () => {
    const result = calculateTripScore(
        makeTrip([40, 50]),
        config,
    );

    assert.ok(result.scoringStatus === "Unscored");
    assert.equal(result.score, null);
    assert.equal(result.reason, "INSUFFICIENT_READINGS");
});

test("missing, zero or invalid distance returns Unscored", () => {
    const distances = [null, 0, -1, NaN, Infinity];

    for (const distanceKm of distances) {
        const result = calculateTripScore(
            { ...makeTrip([40, 50, 60, 70, 80]), distanceKm },
            config,
        );

        assert.ok(result.scoringStatus === "Unscored");
        assert.equal(result.reason, "MISSING_OR_INVALID_DISTANCE");
        assert.equal(result.score, null);
    }
});

test("distance below the configured minimum returns Unscored", () => {
    const result = calculateTripScore(
        makeTrip([40, 50, 60, 70, 80], 0.05),
        config,
    );

    assert.ok(result.scoringStatus === "Unscored");
    assert.equal(result.reason, "BELOW_MINIMUM_DISTANCE");
});

test("missing speed is ignored, not counted as zero", () => {
    const result = calculateTripScore(
        makeTrip([null, 40, 50, 60, 70]),
        config,
    );

    assert.equal(result.scoringStatus, "Unscored");
    assert.equal(result.validReadings, 4);
    assert.equal(result.ignoredReadings, 1);
});

test("duplicate timestamps do not inflate the reading count", () => {
    const trip = makeTrip([40, 50, 60, 70, 80]);

    const result = calculateTripScore(
        { ...trip, samples: [...trip.samples, ...trip.samples.map(s => ({ ...s, sample_id: `copy-${s.sample_id}` }))] },
        config,
    );

    assert.equal(result.validReadings, 5);
    assert.equal(result.duplicateTimestampReadings, 5);
    assert.equal(result.score, 100);
});

test("samples from another trip are rejected", () => {
    const trip = makeTrip([40, 50, 60, 70, 80]);
    const result = calculateTripScore(
        { ...trip, tripId: "different-trip" },
        config,
    );

    assert.ok(result.scoringStatus === "Unscored");
    assert.equal(result.reason, "TRIP_ID_MISMATCH");
});

function withLimits(speeds: readonly (number | null)[], limits: readonly (number | null)[], distanceKm = 1): TripScoringInput {
    const trip = makeTrip(speeds, distanceKm);
    return { ...trip, samples: trip.samples.map((s, i) => ({ ...s, road_speed_limit_kmh: limits[i] ?? null })) };
}

test('at posted limit plus tolerance produces no events, including speeds over the old 85 threshold', () => {
    const result = calculateTripScore(withLimits([35, 55, 85, 105, 65], [30, 50, 80, 100, 60]), config);
    assert.ok(result.scoringStatus === 'Scored');
    assert.equal(result.speedingEvents, 0);
    assert.equal(result.score, 100);
    assert.ok(result.sampleDecisions.every(s => s.status === 'used' && s.usedFallback === false));
});

test('posted limits detect speeding below 85 and a limit transition can end/start an event', () => {
    const result = calculateTripScore(withLimits([60, 60, 60, 60, 60], [50, 50, 80, 40, 40]), config);
    assert.ok(result.scoringStatus === 'Scored');
    assert.equal(result.speedingEvents, 2);
    assert.equal(result.score, 96);
    assert.deepEqual(result.sampleDecisions.map(d => d.startsEvent), [true, false, false, true, false]);
});

test('fallback is the final 85 threshold, not 85 plus tolerance', () => {
    const result = calculateTripScore(withLimits([85, 85.01, 86, 85, 0], [null, null, null, null, null]), config);
    assert.ok(result.scoringStatus === 'Scored');
    assert.equal(result.speedingEvents, 1);
    assert.ok(result.sampleDecisions.every(s => s.usedFallback && s.thresholdKmh === 85 && s.toleranceKmhUsed === 0));
});

test('mixed limits/fallback preserve continuous events and a hand calculation for a 0.3 km trip', () => {
    // thresholds: 55,55,85,85,65; speeding: F,T,F,T,F => 2 events.
    // Existing formula: round(100 - (2 * 2) / 0.3) = 87.
    const result = calculateTripScore(withLimits([55, 56, 70, 86, 65], [50, 50, null, null, 60], 0.3), config);
    assert.ok(result.scoringStatus === 'Scored');
    assert.equal(result.speedingEvents, 2);
    assert.equal(result.score, 87);
    assert.deepEqual(result.sampleDecisions.map(s => s.usedFallback), [false, false, true, true, false]);
    const continuous = calculateTripScore(withLimits([60, 86, 70, 90, 80], [50, null, 60, null, 60]), config);
    assert.ok(continuous.scoringStatus === 'Scored');
    assert.equal(continuous.speedingEvents, 1);
});

test('configured tolerance affects posted limits while fallback stays unchanged', () => {
    const trip = withLimits([56, 55, 55, 85.1, 85], [50, 50, 50, null, null]);
    const result = calculateTripScore(trip, { ...config, toleranceKmh: 7 });
    assert.ok(result.scoringStatus === 'Scored');
    assert.equal(result.speedingEvents, 1);
    assert.deepEqual(result.sampleDecisions.map(d => d.thresholdKmh), [57, 57, 57, 85, 85]);
});

test('minimum distance is inclusive; shorter trips are unscored without false fallback markers', () => {
    const trip = withLimits([90, 0, 0, 0, 0], [null, null, null, null, null], 0.1);
    assert.equal(calculateTripScore(trip, config).score, 80);
    const result = calculateTripScore({ ...trip, distanceKm: 0.099 }, config);
    assert.equal(result.scoringStatus, 'Unscored');
    assert.ok(result.sampleDecisions.every(d => d.status === 'unscored' && d.usedFallback === null));
});

test('duplicate timestamps select highest speed together with its own limit, not another sample limit', () => {
    const trip = withLimits([59, 0, 0, 0, 0], [30, 50, 50, 50, 50]);
    const extra = { ...trip.samples[0]!, sample_id: 'higher-speed', speed_kmh: 60, road_speed_limit_kmh: 80 };
    const result = calculateTripScore({ ...trip, samples: [...trip.samples, extra] }, config);
    assert.ok(result.scoringStatus === 'Scored');
    assert.equal(result.speedingEvents, 0);
    assert.equal(result.sampleDecisions[0]!.status, 'duplicate');
    assert.equal(result.sampleDecisions.at(-1)!.thresholdKmh, 85);
    assert.equal(result.sampleDecisions.at(-1)!.usedFallback, false);
});

test('equal-speed duplicate tie resolves by stable ID regardless of order', () => {
    const trip = withLimits([60, 0, 0, 0, 0], [80, 50, 50, 50, 50]);
    const extra = { ...trip.samples[0]!, sample_id: 'a', road_speed_limit_kmh: 50 };
    for (const samples of [[extra, ...trip.samples], [...trip.samples, extra]]) {
        const result = calculateTripScore({ ...trip, samples }, config);
        assert.ok(result.scoringStatus === 'Scored');
        assert.equal(result.speedingEvents, 1);
        assert.equal(result.sampleDecisions.find(d => d.sampleId === 'a')!.status, 'used');
    }
});

test('invalid stored limits fail instead of silently turning into fallback', () => {
    for (const invalid of [0, -1, NaN, Infinity]) {
        const trip = withLimits([0, 0, 0, 0, 0], [invalid, 50, 50, 50, 50]);
        assert.throws(() => calculateTripScore(trip, config), /stored road speed limit/);
    }
});
