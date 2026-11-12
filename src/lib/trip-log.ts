import type { CompletionLog } from '../services/complete-trip.js';

/** Explicit allowlist; no serialization of arbitrary errors or payloads. */
export function logTripCompletion(requestId: string, event: CompletionLog): void {
    console.error(JSON.stringify({ event: 'trip_completion_failed', requestId,
        tripId: event.tripId, stage: event.stage, code: event.code, retryable: event.retryable,
        httpStatus: event.httpStatus, timestamp: new Date().toISOString() }));
}
