import type { TripScoringConfig } from '../config/trip-scoring-config.ts';
import { calculateTripDistanceKm } from './trip-distance.ts';
import { calculateTripScore } from './trip-scoring.ts';
import type { RecordedTripResult } from '../types/recorded-trip.js';
import type { Trip } from '../types/trip.js';
import type { TripScoringResult } from './trip-scoring.js';

export interface ScoringDependencies {
    readRecordedTripData(tripId: string): Promise<RecordedTripResult>;
    saveTripScore(tripId: string, result: TripScoringResult, config: TripScoringConfig, distanceKm?: number): Promise<Trip | null>;
}
export async function scoreEndedTrip(
    tripId: string,
    config: TripScoringConfig,
    dependencies: ScoringDependencies,
) {
    const loaded = await dependencies.readRecordedTripData(tripId);
    if (loaded.status === 'Unscored') {
        const result = calculateTripScore({ tripId, distanceKm: null, samples: [] }, config);
        if (result.scoringStatus === 'Unscored') result.reason = 'NO_GPS_READINGS';
        return dependencies.saveTripScore(tripId, result, config);
    }
    if (loaded.status !== 'Ready') return null;

    const { input } = loaded;
    const distanceKm = input.distanceKm ?? calculateTripDistanceKm(input.samples);
    const result = calculateTripScore({ ...input, distanceKm }, config);
    return dependencies.saveTripScore(tripId, result, config, distanceKm ?? undefined);
}
