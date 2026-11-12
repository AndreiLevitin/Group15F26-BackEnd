import { completeTrip } from '../src/services/complete-trip.ts';
import { createTripCompletionDependencies } from '../src/lib/trip-completion-dependencies.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'invalid_request', message: 'Request body must be valid JSON.' }, { status: 400 }); }
    if (!body || typeof body !== 'object' || !('tripId' in body) ||
        typeof body.tripId !== 'string' || !uuidPattern.test(body.tripId)) {
        return Response.json({ error: 'invalid_request', message: 'tripId must be a valid UUID.' }, { status: 400 });
    }
    const result = await completeTrip(body.tripId, createTripCompletionDependencies());
    switch (result.kind) {
        case 'Completed': return Response.json({ trip: result.trip });
        case 'NotFound': return Response.json({ error: 'trip_not_found', message: 'Trip was not found.' }, { status: 404 });
        case 'NotActive': return Response.json({ error: 'trip_not_active', trip: result.trip }, { status: 409 });
        case 'Failed': return Response.json({ error: result.error, retryable: result.retryable },
            { status: result.rejectedTrace ? 422 : 503 });
    }
}
