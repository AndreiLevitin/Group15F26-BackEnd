import type { UserTripRepository } from '../repositories/user-trip-repository.js';
import type { Trip } from '../types/trip.js';
import type { TripCompletionResult } from './complete-trip.ts';
import type { Authenticate } from './request-auth.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * POST /api/end-trip. Ownership is confirmed with the user's own token
 * (so RLS applies) before scoring runs; scoring itself needs the service
 * role because it writes results users can never write.
 */
export function createEndTripHandler(
    authenticate: Authenticate,
    trips: Pick<UserTripRepository, 'findTrip'>,
    complete: (tripId: string) => Promise<TripCompletionResult>,
) {
    return async function POST(request: Request): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        let body: unknown;
        try { body = await request.json(); }
        catch { return Response.json({ error: 'invalid_request', message: 'Request body must be valid JSON.' }, { status: 400 }); }
        if (!body || typeof body !== 'object' || !('tripId' in body) ||
            typeof body.tripId !== 'string' || !uuidPattern.test(body.tripId)) {
            return Response.json({ error: 'invalid_request', message: 'tripId must be a valid UUID.' }, { status: 400 });
        }
        const tripId = body.tripId;

        let owned: Trip | null;
        try {
            owned = await trips.findTrip(auth.access, tripId);
        } catch (error) {
            console.error('Failed to check trip ownership:', error);
            return Response.json({ error: 'trip_lookup_failed', retryable: true }, { status: 503 });
        }
        // Someone else's trip is reported exactly like a missing one.
        if (!owned) return Response.json({ error: 'trip_not_found', message: 'Trip was not found.' }, { status: 404 });

        const result = await complete(tripId);
        switch (result.kind) {
            case 'Completed': return Response.json({ trip: result.trip });
            case 'NotFound': return Response.json({ error: 'trip_not_found', message: 'Trip was not found.' }, { status: 404 });
            case 'NotActive': return Response.json({ error: 'trip_not_active', trip: result.trip }, { status: 409 });
            case 'Failed': return Response.json({ error: result.error, retryable: result.retryable },
                { status: result.rejectedTrace ? 422 : 503 });
        }
    };
}
