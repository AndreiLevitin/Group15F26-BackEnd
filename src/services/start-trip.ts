import type { ConsentRepository } from '../repositories/consent-repository.js';
import type { UserTripRepository } from '../repositories/user-trip-repository.js';
import type { PermissionLevel, Trip } from '../types/trip.js';
import type { Authenticate } from './request-auth.ts';

function activeTripResponse(trip: Trip) {
    return Response.json(
        { error: 'active_trip_exists', message: 'An active trip already exists.', trip },
        { status: 409 },
    );
}
function consentRequiredResponse() {
    return Response.json(
        {
            error: 'consent_required',
            message: 'Consent to driving-data collection is required before starting a trip.',
        },
        { status: 403 },
    );
}

/** POST /api/start-trip: starts a trip owned by the signed-in account. */
export function createStartTripHandler(
    authenticate: Authenticate,
    trips: Pick<UserTripRepository, 'findActiveTrip' | 'createActiveTrip'>,
    consent: Pick<ConsentRepository, 'findConsent'>,
) {
    return async function POST(request: Request): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        // Consent comes before any trip work (AB#106): an account that has
        // not consented starts nothing, and a failed read refuses the start
        // as unavailable rather than guessing either way.
        let consentedAt: string | null;
        try {
            consentedAt = await consent.findConsent(auth.access.userId);
        } catch (error) {
            console.error('Failed to read consent:', error);
            return Response.json({ error: 'consent_unavailable' }, { status: 503 });
        }
        if (!consentedAt) return consentRequiredResponse();

        let activeTrip: Trip | null;
        try {
            activeTrip = await trips.findActiveTrip(auth.access);
        } catch (error) {
            console.error('Failed to find active trip:', error);
            return Response.json({ error: 'trip_lookup_failed' }, { status: 503 });
        }
        if (activeTrip) return activeTripResponse(activeTrip);
        // The trip records the location permission it runs under (AB#207).
        // A start that does not name a known level is refused and creates
        // nothing: only the current app calls this endpoint and it always
        // sends the level, so a missing or wrong one means a broken caller.
        let permissionLevel: PermissionLevel;
        try {
            const body = (await request.json()) as { permission_level?: unknown } | null;
            const level = body?.permission_level;
            if (
                level !== 'background' && level !== 'foreground' &&
                level !== 'approximate' && level !== 'denied'
            ) {
                return Response.json({ error: 'permission_level_required' }, { status: 400 });
            }
            permissionLevel = level;
        } catch {
            return Response.json({ error: 'permission_level_required' }, { status: 400 });
        }

        try {
            const trip = await trips.createActiveTrip(auth.access, permissionLevel);
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
