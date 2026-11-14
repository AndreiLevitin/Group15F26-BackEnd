import type { UserTripRepository } from '../repositories/user-trip-repository.js';
import type { Trip } from '../types/trip.js';
import type { Authenticate } from './request-auth.ts';

function activeTripResponse(trip: Trip) {
    return Response.json(
        { error: 'active_trip_exists', message: 'An active trip already exists.', trip },
        { status: 409 },
    );
}

/** POST /api/start-trip: starts a trip owned by the signed-in account. */
export function createStartTripHandler(
    authenticate: Authenticate,
    trips: Pick<UserTripRepository, 'findActiveTrip' | 'createActiveTrip'>,
) {
    return async function POST(request: Request): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        let activeTrip: Trip | null;
        try {
            activeTrip = await trips.findActiveTrip(auth.access);
        } catch (error) {
            console.error('Failed to find active trip:', error);
            return Response.json({ error: 'trip_lookup_failed' }, { status: 503 });
        }
        if (activeTrip) return activeTripResponse(activeTrip);

        try {
            const trip = await trips.createActiveTrip(auth.access);
            if (trip) return Response.json({ trip }, { status: 201 });

            // Lost a race with a concurrent start for the same account.
            const concurrent = await trips.findActiveTrip(auth.access);
            if (concurrent) return activeTripResponse(concurrent);
            throw new Error('Active-trip conflict without an active trip');
        } catch (error) {
            console.error('Failed to create trip:', error);
            return Response.json({ error: 'trip_creation_failed' }, { status: 503 });
        }
    };
}
