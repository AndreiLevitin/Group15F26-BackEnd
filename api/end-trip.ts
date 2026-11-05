import { supabase } from '../src/lib/supabase.js';
import { tripFields, type EndTripRequest, type Trip } from '../src/types/trip.js';

const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isEndTripRequest(value: unknown): value is EndTripRequest {
    return (
        typeof value === 'object' &&
        value !== null &&
        'tripId' in value &&
        typeof value.tripId === 'string' &&
        uuidPattern.test(value.tripId)
    );
}

export async function POST(request: Request) {
    let body: unknown;

    try {
        body = await request.json();
    } catch {
        return Response.json(
            { error: 'invalid_request', message: 'Request body must be valid JSON.' },
            { status: 400 },
        );
    }

    if (!isEndTripRequest(body)) {
        return Response.json(
            {
                error: 'invalid_request',
                message: 'tripId must be a valid UUID.',
            },
            { status: 400 },
        );
    }

    try {
        const { data: trip, error: updateError } = await supabase
            .from('trips')
            .update({
                end_time: new Date().toISOString(),
                status: 'Processing',
            })
            .eq('trip_id', body.tripId)
            .eq('status', 'Active')
            .is('end_time', null)
            .select(tripFields)
            .maybeSingle();

        if (updateError) {
            console.error('Failed to end trip:', updateError.message);
            return Response.json(
                { error: 'trip_update_failed' },
                { status: 503 },
            );
        }

        if (trip) {
            return Response.json({ trip });
        }

        const { data: existingTrip, error: lookupError } = await supabase
            .from('trips')
            .select(tripFields)
            .eq('trip_id', body.tripId)
            .maybeSingle();

        if (lookupError) {
            console.error('Failed to find trip after update:', lookupError.message);
            return Response.json(
                { error: 'trip_lookup_failed' },
                { status: 503 },
            );
        }

        if (!existingTrip) {
            return Response.json(
                { error: 'trip_not_found', message: 'Trip was not found.' },
                { status: 404 },
            );
        }

        return Response.json(
            {
                error: 'trip_not_active',
                message: 'Trip has already ended or is not active.',
                trip: existingTrip as Trip,
            },
            { status: 409 },
        );
    } catch (error) {
        console.error('Unexpected error while ending trip:', error);
        return Response.json(
            { error: 'trip_update_failed' },
            { status: 503 },
        );
    }
}
