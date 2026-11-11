import { createTripScoringConfig, type TripScoringConfig } from '../config/trip-scoring-config.ts';
import { calculateTripDistanceKm } from './trip-distance.ts';
import { calculateTripScore } from './trip-scoring.ts';
import type { readRecordedTripData } from '../repositories/recorded-trip-repository.js';
import type { saveTripScore } from '../repositories/trip-score-repository.js';

type ScoringDependencies = {
    readRecordedTripData: typeof readRecordedTripData;
    saveTripScore: typeof saveTripScore;
};

export function loadTripScoringConfig(env: NodeJS.ProcessEnv): TripScoringConfig {
    function requiredNumber(name: string): number {
        const raw = env[name]?.trim();
        const value = raw ? Number(raw) : NaN;
        if (!Number.isFinite(value)) throw new Error(`Missing or invalid ${name}.`);
        return value;
    }

    const minValidReadings = requiredNumber('TRIP_MIN_VALID_READINGS');
    const minDistanceKm = requiredNumber('TRIP_MIN_DISTANCE_KM');
    const speedingPenaltyPerEvent = requiredNumber('TRIP_SPEEDING_PENALTY_PER_EVENT');
    const toleranceKmh = requiredNumber('TRIP_SPEED_TOLERANCE_KMH');
    const fallbackThresholdKmh = requiredNumber('TRIP_FALLBACK_SPEED_THRESHOLD_KMH');

    if (!Number.isSafeInteger(minValidReadings) || minValidReadings < 2 ||
        minDistanceKm <= 0 || speedingPenaltyPerEvent < 0 || toleranceKmh < 0 || fallbackThresholdKmh <= 0) {
        throw new Error('Invalid trip scoring limits.');
    }

    return createTripScoringConfig({ minValidReadings, minDistanceKm, speedingPenaltyPerEvent,
        toleranceKmh, fallbackThresholdKmh });
}

export async function scoreEndedTrip(
    tripId: string,
    config: TripScoringConfig,
    dependencies: ScoringDependencies,
) {
    const loaded = await dependencies.readRecordedTripData(tripId);
    if (loaded.status === 'Unscored') {
        return dependencies.saveTripScore(tripId, { scoringStatus: 'Unscored', score: null,
            reason: 'NO_GPS_READINGS', validReadings: 0, ignoredReadings: 0,
            duplicateTimestampReadings: 0, sampleDecisions: [] }, config);
    }
    if (loaded.status !== 'Ready') return null;

    const { input } = loaded;
    const distanceKm = input.distanceKm ?? calculateTripDistanceKm(input.samples);
    const result = calculateTripScore({ ...input, distanceKm }, config);
    return dependencies.saveTripScore(tripId, result, config, distanceKm ?? undefined);
}
