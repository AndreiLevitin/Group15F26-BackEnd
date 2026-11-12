import { supabase } from '../lib/supabase.js';
import type { Trip } from '../types/trip.js';
import { tripFields } from '../types/trip.js';

export type StoredTripResult = Pick<Trip, 'trip_id' | 'start_time' | 'end_time' | 'status' | 'distance_km' | 'trip_score'>;

// Shared trip columns the trip-result queries select from, including
// the detail fields the single-trip response added.
export async function findTripResult(tripId: string): Promise<StoredTripResult | null> {
    const { data, error } = await supabase
        .from('trips')
        .select(tripFields)
        .eq('trip_id', tripId)
        .maybeSingle();

    if (error) throw new Error(`Could not read trip result: ${error.message}`);
    return data;
}
