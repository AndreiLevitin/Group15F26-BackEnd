import type { Trip } from '../types/trip.js';
import type { TripScoringConfig } from '../config/trip-scoring-config.js';
import { scoreEndedTrip, type ScoringDependencies } from './score-ended-trip.ts';
import { EnrichmentBusyError } from './enrich-trip-speed-limits.ts';
import { SpeedLimitProviderError } from '../types/speed-limit-errors.ts';

export interface TripCompletionRepository {
    beginProcessing(tripId: string, endedAt: string): Promise<Trip | null>;
    findTrip(tripId: string): Promise<Trip | null>;
}
export interface CompletionLog {
    tripId: string;
    stage: 'transition' | 'lookup' | 'configuration' | 'enrichment' | 'scoring';
    code: string;
    retryable: boolean;
    httpStatus?: number;
}
export interface TripCompletionDependencies {
    repository: TripCompletionRepository;
    scoring: ScoringDependencies;
    getConfig(): TripScoringConfig;
    enrich(tripId: string): Promise<void>;
    log(event: CompletionLog): void;
}
export type TripCompletionResult =
    | { kind: 'Completed'; trip: Trip }
    | { kind: 'NotFound' }
    | { kind: 'NotActive'; trip: Trip }
    | { kind: 'Failed'; error: string; retryable: boolean; rejectedTrace: boolean };

/** Application use case: no HTTP, Supabase or vendor dependencies. */
export async function completeTrip(tripId: string, deps: TripCompletionDependencies): Promise<TripCompletionResult> {
    let stage: CompletionLog['stage'] = 'transition';
    try {
        let trip = await deps.repository.beginProcessing(tripId, new Date().toISOString());
        if (!trip) {
            stage = 'lookup';
            trip = await deps.repository.findTrip(tripId);
        }
        if (!trip) return { kind: 'NotFound' };
        if (trip.status === 'Completed') return { kind: 'Completed', trip };
        if (trip.status !== 'Processing' || !trip.end_time) return { kind: 'NotActive', trip };
        stage = 'configuration';
        const config = deps.getConfig();
        stage = 'enrichment';
        await deps.enrich(tripId);
        stage = 'scoring';
        const completed = await scoreEndedTrip(tripId, config, deps.scoring);
        if (completed) return { kind: 'Completed', trip: completed };
        throw new Error('Scoring did not complete.');
    } catch (error) {
        if (stage === 'enrichment' || stage === 'scoring') {
            const completed = await deps.repository.findTrip(tripId).catch(() => null);
            if (completed?.status === 'Completed') return { kind: 'Completed', trip: completed };
        }
        const provider = error instanceof SpeedLimitProviderError ? error : null;
        const retryable = stage === 'configuration' ? false : provider?.retryable ?? true;
        const code = provider?.code ?? (error instanceof EnrichmentBusyError ? 'enrichment_busy' : 'operation_failed');
        try {
            deps.log({ tripId, stage, code, retryable,
                ...(provider?.httpStatus === undefined ? {} : { httpStatus: provider.httpStatus }) });
        } catch { /* Logging must not change business state or the response. */ }
        return { kind: 'Failed', retryable,
            rejectedTrace: provider?.code === 'request_limit' || provider?.code === 'invalid_trace',
            error: stage === 'enrichment' ? 'trip_speed_limits_unavailable' : stage === 'configuration' ?
                'trip_scoring_unavailable' : stage === 'scoring' ? 'trip_scoring_failed' :
                stage === 'lookup' ? 'trip_lookup_failed' : 'trip_update_failed' };
    }
}
