export interface ScoringParameters {
    minValidReadings: number;
    minDistanceKm: number;
    speedingPenaltyPerEvent: number;
    toleranceKmh: number;
    /** Final fallback threshold; tolerance must not be added again. */
    fallbackThresholdKmh: number;
}
export type TripScoringConfig = ScoringParameters;
export function createTripScoringConfig(
    parameters: ScoringParameters,
): TripScoringConfig {
    return { ...parameters };
}
