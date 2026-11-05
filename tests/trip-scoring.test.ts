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
});

function makeTrip(
    speeds: readonly (number | null)[],
    distanceKm = 1,
): TripScoringInput {
    return {
        tripId: "test-trip",
        distanceKm,
        samples: speeds.map((speed, index) => ({
            trip_id: "test-trip",
            recorded_at: new Date(
                Date.UTC(2026, 8, 12, 15, 0, index),
            ).toISOString(),
            latitude: 43.4,
            longitude: -80.5,
            speed_kmh: speed,
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
        { ...trip, samples: [...trip.samples, ...trip.samples] },
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