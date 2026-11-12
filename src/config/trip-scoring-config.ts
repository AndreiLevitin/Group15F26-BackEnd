export interface SpeedScoreBand {
    /** Inclusive excess above the posted limit. First band starts at zero. */
    fromKmh: number;
    score: number;
}
export interface TripScoringConfig {
    minValidReadings: number;
    minDistanceKm: number;
    toleranceKmh: number;
    maxIntervalSeconds: number;
    minMovingSpeedKmh: number;
    bands: readonly SpeedScoreBand[];
}
export function createTripScoringConfig(parameters: TripScoringConfig): TripScoringConfig {
    const finite = (n: number) => typeof n === 'number' && Number.isFinite(n);
    if (!Number.isSafeInteger(parameters.minValidReadings) || parameters.minValidReadings < 2 ||
        !finite(parameters.minDistanceKm) || parameters.minDistanceKm <= 0 ||
        !finite(parameters.toleranceKmh) || parameters.toleranceKmh < 0 ||
        !finite(parameters.maxIntervalSeconds) || parameters.maxIntervalSeconds <= 0 ||
        !finite(parameters.minMovingSpeedKmh) || parameters.minMovingSpeedKmh < 0) {
        throw new RangeError('Invalid trip scoring limits.');
    }
    const bands: unknown = parameters.bands;
    if (!Array.isArray(bands) || bands.length < 2 || bands.length > 20 || bands.some((b, i) =>
        !b || !finite(b.fromKmh) || !finite(b.score) || b.score < 0 || b.score > 100 ||
        (i === 0 ? b.fromKmh !== 0 : b.fromKmh <= bands[i - 1].fromKmh || b.score > bands[i - 1].score)) ||
        bands[1].fromKmh <= parameters.toleranceKmh) {
        throw new RangeError('Invalid speed score bands. Use increasing boundaries and non-increasing scores.');
    }
    return { ...parameters, bands: bands.map(b => ({ fromKmh: b.fromKmh, score: b.score })) };
}
export function loadTripScoringConfig(env: NodeJS.ProcessEnv): TripScoringConfig {
    function requiredNumber(name: string): number {
        const value = env[name]?.trim() ? Number(env[name]) : NaN;
        if (!Number.isFinite(value)) throw new Error(`Missing or invalid ${name}.`);
        return value;
    }
    let bands: SpeedScoreBand[];
    try { bands = JSON.parse(env.TRIP_SPEED_SCORE_BANDS ?? ''); }
    catch { throw new Error('Missing or invalid TRIP_SPEED_SCORE_BANDS.'); }
    return createTripScoringConfig({
        minValidReadings: requiredNumber('TRIP_MIN_VALID_READINGS'),
        minDistanceKm: requiredNumber('TRIP_MIN_DISTANCE_KM'),
        toleranceKmh: requiredNumber('TRIP_SPEED_TOLERANCE_KMH'),
        maxIntervalSeconds: requiredNumber('TRIP_MAX_SCORING_INTERVAL_SECONDS'),
        minMovingSpeedKmh: requiredNumber('TRIP_MIN_MOVING_SPEED_KMH'), bands,
    });
}
