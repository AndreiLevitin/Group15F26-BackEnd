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
// Agreed PoC defaults. Each load returns its own validated copy for the trip snapshot.
const defaults: TripScoringConfig = {
    minValidReadings: 5,
    minDistanceKm: 0.1,
    toleranceKmh: 5,
    maxIntervalSeconds: 3,
    minMovingSpeedKmh: 5,
    bands: [{ fromKmh: 0, score: 80 }, { fromKmh: 16, score: 60 },
        { fromKmh: 30, score: 40 }, { fromKmh: 50, score: 0 }],
};
export function loadTripScoringConfig(env: NodeJS.ProcessEnv): TripScoringConfig {
    function numberOverride(name: string, fallback: number): number {
        const raw = env[name];
        if (raw === undefined) return fallback;
        const value = raw.trim() ? Number(raw) : NaN;
        if (!Number.isFinite(value)) throw new Error(`Invalid ${name}.`);
        return value;
    }
    let bands = defaults.bands;
    if (env.TRIP_SPEED_SCORE_BANDS !== undefined) {
        try { bands = JSON.parse(env.TRIP_SPEED_SCORE_BANDS); }
        catch { throw new Error('Invalid TRIP_SPEED_SCORE_BANDS.'); }
    }
    return createTripScoringConfig({
        minValidReadings: numberOverride('TRIP_MIN_VALID_READINGS', defaults.minValidReadings),
        minDistanceKm: numberOverride('TRIP_MIN_DISTANCE_KM', defaults.minDistanceKm),
        toleranceKmh: numberOverride('TRIP_SPEED_TOLERANCE_KMH', defaults.toleranceKmh),
        maxIntervalSeconds: numberOverride('TRIP_MAX_SCORING_INTERVAL_SECONDS', defaults.maxIntervalSeconds),
        minMovingSpeedKmh: numberOverride('TRIP_MIN_MOVING_SPEED_KMH', defaults.minMovingSpeedKmh), bands,
    });
}
