import { randomUUID } from 'node:crypto';
import { loadTripScoringConfig } from '../config/trip-scoring-config.ts';
import { loadSpeedLimitConfig } from '../config/speed-limit-config.ts';
import { tripCompletionRepository } from '../repositories/trip-completion-repository.ts';
import { readRecordedTripData } from '../repositories/recorded-trip-repository.ts';
import { saveTripScore } from '../repositories/trip-score-repository.ts';
import { tripSpeedLimitRepository } from '../repositories/trip-speed-limit-repository.ts';
import { enrichTripSpeedLimits } from '../services/enrich-trip-speed-limits.ts';
import { TomTomSpeedLimitProvider } from '../services/tomtom-speed-limit-provider.ts';
import type { TripCompletionDependencies } from '../services/complete-trip.js';
import { logTripCompletion } from './trip-log.ts';

/** Composition root: all concrete storage/provider/environment choices live here. */
export function createTripCompletionDependencies(): TripCompletionDependencies {
    const requestId = randomUUID();
    return {
        repository: tripCompletionRepository,
        scoring: { readRecordedTripData, saveTripScore },
        getConfig() {
            loadSpeedLimitConfig(process.env);
            return loadTripScoringConfig(process.env);
        },
        async enrich(tripId) {
            const config = loadSpeedLimitConfig(process.env);
            if (config) await enrichTripSpeedLimits(tripId, new TomTomSpeedLimitProvider(config), tripSpeedLimitRepository);
        },
        log: event => logTripCompletion(requestId, event),
    };
}
