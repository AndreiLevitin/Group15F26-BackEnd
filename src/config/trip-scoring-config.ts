export interface ScoringParameters {
    minValidReadings: number;
    minDistanceKm: number;
    speedingPenaltyPerEvent: number;
}
export interface TripScoringConfig extends ScoringParameters {
    speedLimitKmh: number;
    toleranceKmh: number;
}
export function createTripScoringConfig(
    parameters: ScoringParameters,
): TripScoringConfig {
    return {
        ...parameters,
        speedLimitKmh: 80,
        toleranceKmh: 5,
    };
}