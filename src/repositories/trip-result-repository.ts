import { createUserClient } from '../lib/supabase.js';
import type { TripAccess } from '../types/auth.js';
import type { Trip } from '../types/trip.js';
import { tripFields } from '../types/trip.js';

export type StoredTripResult = Pick<Trip, 'trip_id' | 'start_time' | 'end_time' | 'status' | 'distance_km' | 'trip_score'>;

// Shared trip columns the trip-result queries select from, including
// the detail fields the single-trip response added.
// AB#77: runs as the signed-in user, so RLS only returns their own trip.
export async function findTripResult(access: TripAccess, tripId: string): Promise<StoredTripResult | null> {
    const { data, error } = await createUserClient(access.accessToken)
        .from('trips')
        .select(tripFields)
        .eq('trip_id', tripId)
        .eq('user_id', access.userId)
        .maybeSingle();

    if (error) throw new Error(`Could not read trip result: ${error.message}`);
    return data;
}
