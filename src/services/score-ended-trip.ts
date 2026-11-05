import { createTripScoringConfig, type TripScoringConfig } from '../config/trip-scoring-config.js';
import { calculateTripDistanceKm } from './trip-distance.js';
import { calculateTripScore } from './trip-scoring.js';
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

    if (!Number.isSafeInteger(minValidReadings) || minValidReadings < 2 ||
        minDistanceKm <= 0 || speedingPenaltyPerEvent < 0) {
        throw new Error('Invalid trip scoring limits.');
    }

    return createTripScoringConfig({ minValidReadings, minDistanceKm, speedingPenaltyPerEvent });
}

export async function scoreEndedTrip(
    tripId: string,
    config: TripScoringConfig,
    dependencies: ScoringDependencies,
) {
    const loaded = await dependencies.readRecordedTripData(tripId);
    if (loaded.status === 'Unscored') {
        return dependencies.saveTripScore(tripId, null);
    }
    if (loaded.status !== 'Ready') return null;

    const { input } = loaded;
    const distanceKm = input.distanceKm ?? calculateTripDistanceKm(input.samples);
    const { score } = calculateTripScore({ ...input, distanceKm }, config);
    return dependencies.saveTripScore(tripId, score, distanceKm ?? undefined);
}
