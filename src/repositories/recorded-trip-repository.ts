import { supabase } from '../lib/supabase.js';
import { tripFields, type Trip } from '../types/trip.js';
import type { RecordedTripSample } from '../services/trip-scoring.js';
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
        samples: RecordedTripSample[];
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

    const samples: RecordedTripSample[] = [];
    let offset = 0;

    while (true) {
        const { data: page, error: sampleError } = await supabase
            .from('trip_data_points')
            .select('sample_id, trip_id, recorded_at, latitude, longitude, speed_kmh, limit:trip_sample_speed_limits(speed_limit_kmh, lookup_status)')
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

        for (const row of page) {
            // Supabase relationship cardinality may be represented as an object or
            // singleton array. Never associate road limits by timestamp or row offset.
            const raw = row.limit as unknown;
            if (Array.isArray(raw) && raw.length > 1) throw new Error('Multiple limits for one GPS sample.');
            const limit = (Array.isArray(raw) ? raw[0] : raw) as
                { speed_limit_kmh: number | null; lookup_status: string } | null | undefined;
            if (limit && ((limit.lookup_status === 'available') !== (limit.speed_limit_kmh !== null))) {
                throw new Error('Invalid stored speed-limit status.');
            }
            samples.push({ sample_id: row.sample_id, trip_id: row.trip_id, recorded_at: row.recorded_at,
                latitude: row.latitude, longitude: row.longitude, speed_kmh: row.speed_kmh,
                road_speed_limit_kmh: limit?.speed_limit_kmh ?? null });
        }
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
