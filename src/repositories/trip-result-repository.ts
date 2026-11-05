import { supabase } from '../lib/supabase.js';
import type { Trip } from '../types/trip.js';

export type StoredTripResult = Pick<Trip, 'trip_id' | 'status' | 'trip_score'>;

export async function findTripResult(tripId: string): Promise<StoredTripResult | null> {
    const { data, error } = await supabase
        .from('trips')
        .select('trip_id, status, trip_score')
        .eq('trip_id', tripId)
        .maybeSingle();

    if (error) throw new Error(`Could not read trip result: ${error.message}`);
    return data;
}
