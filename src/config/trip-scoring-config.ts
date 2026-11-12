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
