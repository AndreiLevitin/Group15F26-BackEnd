import type { Authenticate } from './request-auth.ts';
import type { TripAccess } from '../types/auth.js';
import type { Trip } from '../types/trip.js';
import { buildTripHistory } from './trip-history.ts';

type FindUserTripHistory = (access: TripAccess) => Promise<readonly Trip[]>;

export function createTripHistoryHandler(
    findHistory: FindUserTripHistory,
    authenticate: Authenticate,
) {
    return async function GET(request: Request): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        try {
            const trips = await findHistory(auth.access);
            return Response.json(
                { trips: buildTripHistory(trips) },
                { headers: { 'Cache-Control': 'no-store' } },
            );
        } catch {
            console.error('Failed to read trip history.');
            return Response.json(
                { error: 'trip_history_unavailable' },
                { status: 503, headers: { 'Cache-Control': 'no-store' } },
            );
        }
    };
}
