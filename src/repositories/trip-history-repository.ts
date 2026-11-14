import { createUserClient } from '../lib/supabase.js';
import type { TripAccess } from '../types/auth.js';
import { tripFields, type Trip } from '../types/trip.js';

export async function findUserTripHistory(access: TripAccess): Promise<Trip[]> {
    const client = createUserClient(access.accessToken);
    const trips: Trip[] = [];
    const pageSize = 500;

    for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await client
            .from('trips')
            .select(tripFields)
            .eq('user_id', access.userId)
            .order('start_time', { ascending: false })
            .order('trip_id', { ascending: true })
            .range(offset, offset + pageSize - 1);

        if (error) throw new Error(`Could not read trip history: ${error.message}`);
        const page = (data ?? []) as Trip[];
        trips.push(...page);
        if (page.length < pageSize) return trips;
    }
}
