import { supabase } from '../src/lib/supabase.js';
import { tripFields, type EndTripRequest, type Trip } from '../src/types/trip.js';
import { readRecordedTripData } from '../src/repositories/recorded-trip-repository.js';
import { saveTripScore } from '../src/repositories/trip-score-repository.js';
import { loadTripScoringConfig, scoreEndedTrip } from '../src/services/score-ended-trip.js';

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

async function finishScoring(tripId: string, config: ReturnType<typeof loadTripScoringConfig>) {
    try {
        const completed = await scoreEndedTrip(tripId, config, { readRecordedTripData, saveTripScore });
        if (completed) return Response.json({ trip: completed });

        // Another request may have finished the same trip while this one was scoring.
        const { data, error } = await supabase
            .from('trips')
            .select(tripFields)
            .eq('trip_id', tripId)
            .maybeSingle();
        if (error) throw new Error(error.message);
        if (data?.status === 'Completed') return Response.json({ trip: data });
    } catch (error) {
        console.error('Could not finish trip scoring:', error);
    }
    return Response.json({ error: 'trip_scoring_failed' }, { status: 503 });
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

    let config: ReturnType<typeof loadTripScoringConfig>;
    try {
        config = loadTripScoringConfig(process.env);
    } catch (error) {
        console.error('Trip scoring configuration is unavailable:', error);
        return Response.json({ error: 'trip_scoring_unavailable' }, { status: 503 });
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
            return finishScoring(body.tripId, config);
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

        if (existingTrip.status === 'Processing' && existingTrip.end_time) {
            return finishScoring(body.tripId, config);
        }

        if (existingTrip.status === 'Completed') {
            return Response.json({ trip: existingTrip });
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
