import { supabase } from '../src/lib/supabase.js';
import { tripFields, type Trip } from '../src/types/trip.js';

function activeTripResponse(trip: Trip) {
    return Response.json(
        {
            error: 'active_trip_exists',
            message: 'An active trip already exists.',
            trip,
        },
        { status: 409 },
    );
}

export async function POST() {
    try {
        const { data: activeTrip, error: activeTripError } = await supabase
            .from('trips')
            .select(tripFields)
            .eq('status', 'Active')
            .maybeSingle();

        if (activeTripError) {
            console.error('Failed to find active trip:', activeTripError.message);
            return Response.json(
                { error: 'trip_lookup_failed' },
                { status: 503 },
            );
        }

        if (activeTrip) {
            return activeTripResponse(activeTrip);
        }

        const { data: trip, error: insertError } = await supabase
            .from('trips')
            .insert({ status: 'Active' })
            .select(tripFields)
            .single();

        if (insertError) {
            if (insertError.code === '23505') {
                const { data: concurrentActiveTrip, error: concurrentLookupError } =
                    await supabase
                        .from('trips')
                        .select(tripFields)
                        .eq('status', 'Active')
                        .maybeSingle();

                if (!concurrentLookupError && concurrentActiveTrip) {
                    return activeTripResponse(concurrentActiveTrip);
                }
            }

            console.error('Failed to create trip:', insertError.message);
            return Response.json(
                { error: 'trip_creation_failed' },
                { status: 503 },
            );
        }

        return Response.json({ trip }, { status: 201 });
    } catch (error) {
        console.error('Unexpected error while starting trip:', error);
        return Response.json(
            { error: 'trip_creation_failed' },
            { status: 503 },
        );
    }
}
