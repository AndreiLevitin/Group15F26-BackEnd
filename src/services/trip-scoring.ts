import type { TripScoringConfig } from "../config/trip-scoring-config.ts";
export interface RecordedTripSample {
    trip_id: string;
    recorded_at: string;
    latitude: number | null;
    longitude: number | null;
    speed_kmh: number | null;
}
export interface TripScoringInput {
    tripId: string;
    distanceKm: number | null;
    samples: readonly RecordedTripSample[];
}

export type UnscoredReason =
    | "TRIP_ID_MISMATCH"
    | "INSUFFICIENT_READINGS"
    | "MISSING_OR_INVALID_DISTANCE"
    | "BELOW_MINIMUM_DISTANCE";
interface ReadingCounts {
    validReadings: number;
    ignoredReadings: number;
    duplicateTimestampReadings: number;
}

export type TripScoringResult = ReadingCounts & (
    | {
    scoringStatus: "Scored";
    score: number;
    speedingEvents: number;
    distanceKm: number;
}
    | {
    scoringStatus: "Unscored";
    score: null;
    reason: UnscoredReason;
}
    );

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function validateConfig(config: TripScoringConfig): void {
    if (
        !Number.isInteger(config.minValidReadings) ||
        config.minValidReadings < 2
    ) {
        throw new RangeError("minValidReadings must be an integer of at least 2");
    }

    if (
        !isFiniteNumber(config.minDistanceKm) ||
        config.minDistanceKm <= 0
    ) {
        throw new RangeError("minDistanceKm must be positive");
    }

    const keys = [
        "speedLimitKmh",
        "toleranceKmh",
        "speedingPenaltyPerEvent",
    ] as const;
    for (const key of keys) {
        if (!isFiniteNumber(config[key]) || config[key] < 0) {
            throw new RangeError(`${key} must be finite and non-negative`);
        }
    }

    if (!Number.isFinite(config.speedLimitKmh + config.toleranceKmh)) {
        throw new RangeError("The speeding threshold must be finite");
    }
}

function timestampMillis(value: string): number {
    // Require a timezone so the computer's local settings cannot change results.
    const match =
        /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(
            value,
        );

    if (!match) return NaN;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    if (
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > daysInMonth ||
        Number(match[4]) > 23 ||
        Number(match[5]) > 59 ||
        Number(match[6]) > 59
    ) {
        return NaN;
    }

    return Date.parse(value);
}

export function calculateTripScore(
    input: TripScoringInput,
    config: TripScoringConfig,
): TripScoringResult {
    validateConfig(config);

    const counts: ReadingCounts = {
        validReadings: 0,
        ignoredReadings: 0,
        duplicateTimestampReadings: 0,
    };

    const unscored = (reason: UnscoredReason): TripScoringResult => ({
        ...counts,
        scoringStatus: "Unscored",
        score: null,
        reason,
    });

    // Never combine samples belonging to different trips.
    if (
        !input.tripId ||
        input.samples.some(sample => sample.trip_id !== input.tripId)
    ) {
        return unscored("TRIP_ID_MISMATCH");
    }

    const speedByTimestamp = new Map<number, number>();

    for (const sample of input.samples) {
        const time = timestampMillis(sample.recorded_at);
        const { latitude, longitude, speed_kmh: speed } = sample;

        if (
            !Number.isFinite(time) ||
            !isFiniteNumber(latitude) ||
            latitude < -90 ||
            latitude > 90 ||
            !isFiniteNumber(longitude) ||
            longitude < -180 ||
            longitude > 180 ||
            !isFiniteNumber(speed) ||
            speed < 0
        ) {
            counts.ignoredReadings++;
            continue;
        }

        // Proposed duplicate policy: count each timestamp once,
        // keeping the highest valid speed at that instant.
        const previous = speedByTimestamp.get(time);

        if (previous !== undefined) {
            counts.duplicateTimestampReadings++;
        }

        speedByTimestamp.set(
            time,
            previous === undefined ? speed : Math.max(previous, speed),
        );
    }

    counts.validReadings = speedByTimestamp.size;

    if (counts.validReadings < config.minValidReadings) {
        return unscored("INSUFFICIENT_READINGS");
    }

    if (!isFiniteNumber(input.distanceKm) || input.distanceKm <= 0) {
        return unscored("MISSING_OR_INVALID_DISTANCE");
    }

    if (input.distanceKm < config.minDistanceKm) {
        return unscored("BELOW_MINIMUM_DISTANCE");
    }

    const readings = [...speedByTimestamp.entries()].sort(
        ([timeA], [timeB]) => timeA - timeB,
    );

    const threshold = config.speedLimitKmh + config.toleranceKmh;

    let speedingEvents = 0;
    let wasSpeeding = false;

    for (const [, speed] of readings) {
        const isSpeeding = speed > threshold;

        // Consecutive speeding readings form one event.
        if (isSpeeding && !wasSpeeding) {
            speedingEvents++;
        }

        wasSpeeding = isSpeeding;
    }

    const penalty =
        (config.speedingPenaltyPerEvent * speedingEvents) / input.distanceKm;

    const score = Math.round(
        Math.min(100, Math.max(0, 100 - penalty)),
    );

    return {
        ...counts,
        scoringStatus: "Scored",
        score,
        speedingEvents,
        distanceKm: input.distanceKm,
    };
}