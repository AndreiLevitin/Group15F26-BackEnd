import { gpsTimestampMillis, hasValidCoordinates } from './gps-validation.ts';
import type { TripScoringConfig } from "../config/trip-scoring-config.ts";
export interface RecordedTripSample {
    sample_id: string;
    trip_id: string;
    recorded_at: string;
    latitude: number | null;
    longitude: number | null;
    speed_kmh: number | null;
    /** Null means no stored posted limit, not a zero limit or a routing speed. */
    road_speed_limit_kmh: number | null;
}
export interface SampleScoringDecision {
    sampleId: string;
    status: 'used' | 'duplicate' | 'ignored' | 'unscored';
    speedLimitKmhUsed: number | null;
    toleranceKmhUsed: number | null;
    thresholdKmh: number | null;
    usedFallback: boolean | null;
    isSpeeding: boolean | null;
    startsEvent: boolean | null;
}
export interface TripScoringInput {
    tripId: string;
    distanceKm: number | null;
    samples: readonly RecordedTripSample[];
}

export type UnscoredReason =
    | "NO_GPS_READINGS"
    | "TRIP_ID_MISMATCH"
    | "INSUFFICIENT_READINGS"
    | "MISSING_OR_INVALID_DISTANCE"
    | "BELOW_MINIMUM_DISTANCE";
interface ReadingCounts {
    validReadings: number;
    ignoredReadings: number;
    duplicateTimestampReadings: number;
    sampleDecisions: SampleScoringDecision[];
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
        "fallbackThresholdKmh",
        "toleranceKmh",
        "speedingPenaltyPerEvent",
    ] as const;
    for (const key of keys) {
        if (!isFiniteNumber(config[key]) || config[key] < 0) {
            throw new RangeError(`${key} must be finite and non-negative`);
        }
    }

    if (config.fallbackThresholdKmh <= 0) throw new RangeError('Fallback threshold must be positive');
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
        sampleDecisions: input.samples.map(sample => ({ sampleId: sample.sample_id,
            status: 'ignored', speedLimitKmhUsed: null, toleranceKmhUsed: null, thresholdKmh: null,
            usedFallback: null, isSpeeding: null, startsEvent: null })),
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

    const sampleIds = new Set(input.samples.map(s => s.sample_id));
    if (sampleIds.size !== input.samples.length || input.samples.some(s => !s.sample_id)) {
        throw new Error('Scoring samples must have unique stable IDs.');
    }
    const readingByTimestamp = new Map<number, number>();

    for (const [index, sample] of input.samples.entries()) {
        const time = gpsTimestampMillis(sample.recorded_at);
        const { speed_kmh: speed } = sample;

        if (
            !Number.isFinite(time) ||
            !hasValidCoordinates(sample) ||
            !isFiniteNumber(speed) ||
            speed < 0
        ) {
            counts.ignoredReadings++;
            continue;
        }

        if (sample.road_speed_limit_kmh !== null && (!isFiniteNumber(sample.road_speed_limit_kmh) ||
            sample.road_speed_limit_kmh <= 0 || !Number.isFinite(sample.road_speed_limit_kmh + config.toleranceKmh))) {
            throw new Error('Invalid stored road speed limit.');
        }
        // Keep the highest valid speed with THAT sample's limit. Equal-speed ties
        // use the lowest stable ID, so shuffled input cannot change the result.
        const previous = readingByTimestamp.get(time);

        if (previous !== undefined) {
            counts.duplicateTimestampReadings++;
            const previousSample = input.samples[previous]!;
            if (speed < previousSample.speed_kmh! || (speed === previousSample.speed_kmh &&
                sample.sample_id >= previousSample.sample_id)) {
                counts.sampleDecisions[index]!.status = 'duplicate';
                continue;
            }
            counts.sampleDecisions[previous]!.status = 'duplicate';
        }

        counts.sampleDecisions[index]!.status = 'unscored';
        readingByTimestamp.set(time, index);
    }

    counts.validReadings = readingByTimestamp.size;

    if (counts.validReadings < config.minValidReadings) {
        return unscored("INSUFFICIENT_READINGS");
    }

    if (!isFiniteNumber(input.distanceKm) || input.distanceKm <= 0) {
        return unscored("MISSING_OR_INVALID_DISTANCE");
    }

    if (input.distanceKm < config.minDistanceKm) {
        return unscored("BELOW_MINIMUM_DISTANCE");
    }

    const readings = [...readingByTimestamp.entries()].sort(
        ([timeA], [timeB]) => timeA - timeB,
    );

    let speedingEvents = 0;
    let wasSpeeding = false;

    for (const [, index] of readings) {
        const sample = input.samples[index]!;
        const usedFallback = sample.road_speed_limit_kmh === null;
        const limit = sample.road_speed_limit_kmh ?? config.fallbackThresholdKmh;
        const tolerance = usedFallback ? 0 : config.toleranceKmh;
        const threshold = limit + tolerance;
        const isSpeeding = sample.speed_kmh! > threshold;
        const startsEvent = isSpeeding && !wasSpeeding;
        counts.sampleDecisions[index] = { sampleId: sample.sample_id, status: 'used',
            speedLimitKmhUsed: limit, toleranceKmhUsed: tolerance, thresholdKmh: threshold,
            usedFallback, isSpeeding, startsEvent };

        // Consecutive speeding readings form one event.
        if (startsEvent) {
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
