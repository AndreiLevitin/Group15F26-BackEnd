import { supabase } from '../lib/supabase.js';
import { tripFields, type Trip } from '../types/trip.js';
interface RecordedGpsSample {
    trip_id: string;
    recorded_at: string;
    latitude: number | null;
    longitude: number | null;
    speed_kmh: number | null;
}
export type RecordedTripResult =
    | { status: 'NotFound' }
    | { status: 'NotReady' }
    | {
    status: 'Unscored';
    score: null;
    reason: 'NO_GPS_READINGS';
}
    | {
    status: 'Ready';
    input: {
        tripId: string;
        distanceKm: number | null;
        samples: RecordedGpsSample[];
    };
};

const pageSize = 500;

export async function readRecordedTripData(
    tripId: string,
): Promise<RecordedTripResult> {
    const { data, error } = await supabase
        .from('trips')
        .select(tripFields)
        .eq('trip_id', tripId)
        .maybeSingle();

    if (error) {
        throw new Error(`Could not read trip: ${error.message}`);
    }

    if (!data) return { status: 'NotFound' };

    const trip = data as Trip;

    // The upload flow must save all samples before calling end-trip.
    if (trip.status !== 'Processing' || !trip.end_time) {
        return { status: 'NotReady' };
    }

    const storedDistance = trip.distance_km;
    const distanceKm = typeof storedDistance === 'number' &&
        Number.isFinite(storedDistance) && storedDistance > 0 ? storedDistance : null;

    const samples: RecordedGpsSample[] = [];
    let offset = 0;

    while (true) {
        const { data: page, error: sampleError } = await supabase
            .from('trip_data_points')
            .select('trip_id, recorded_at, latitude, longitude, speed_kmh')
            .eq('trip_id', trip.trip_id)
            .not('latitude', 'is', null)
            .not('longitude', 'is', null)
            .order('recorded_at', { ascending: true })
            .order('sample_id', { ascending: true })
            .range(offset, offset + pageSize - 1);

        if (sampleError) {
            throw new Error(`Could not read GPS samples: ${sampleError.message}`);
        }

        if (!page?.length) break;

        samples.push(...(page as RecordedGpsSample[]));
        offset += page.length;
    }

    if (samples.length === 0) {
        return {
            status: 'Unscored',
            score: null,
            reason: 'NO_GPS_READINGS',
        };
    }

    return {
        status: 'Ready',
        input: { tripId: trip.trip_id, distanceKm, samples },
    };
}