import type { StoredTripResult } from '../repositories/trip-result-repository.js';
import type { TripStatus } from '../types/trip.js';

export interface TripResultResponse {
    tripId: string;
    status: TripStatus;
    score: number | null;
    reason: string | null;
    startTime: string;
    endTime: string | null;
    distanceKm: number | null;
    durationSeconds: number | null;
}

type FindTripResult = (tripId: string) => Promise<StoredTripResult | null>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createTripResultHandler(findTripResult: FindTripResult) {
    return async function GET(request: Request): Promise<Response> {
        const json = (body: unknown, status = 200) => Response.json(body, {
            status,
            headers: { 'Cache-Control': 'no-store' },
        });
        const tripIds = new URL(request.url).searchParams.getAll('tripId');
        const tripId = tripIds[0];
        if (tripIds.length !== 1 || !tripId || !uuidPattern.test(tripId)) {
            return json({ error: 'invalid_request', message: 'tripId must be a valid UUID.' }, 400);
        }

        try {
            const trip = await findTripResult(tripId);
            if (!trip) {
                return json({ error: 'trip_not_found', message: 'Trip was not found.' }, 404);
            }

            const durationSeconds = trip.end_time
                ? Math.round((Date.parse(trip.end_time) - Date.parse(trip.start_time)) / 1000)
                : null;

            const result: TripResultResponse = {
                tripId: trip.trip_id,
                status: trip.status,
                score: trip.status === 'Completed' ? trip.trip_score : null,
                // A specific unscored reason is not persisted yet.
                reason: trip.status === 'Completed' && trip.trip_score === null
                    ? 'unscored'
                    : null,
                startTime: trip.start_time,
                endTime: trip.end_time,
                distanceKm: trip.distance_km,
                durationSeconds,
            };
            return json(result);
        } catch (error) {
            console.error('Failed to read trip result:', error);
            return json({ error: 'trip_lookup_failed' }, 503);
        }
    };
}
