// Trip queries made on behalf of a signed-in user (AB#77).
//
// Every query runs on a client carrying the user's access token, so Supabase
// row-level security (database/006_trip_ownership.sql) limits it to that
// user's own trips. The explicit user_id filters below are the first line of
// defence; RLS is the backstop if one is ever missed.
import { createUserClient } from '../lib/supabase.js';
import type { TripAccess } from '../types/auth.js';
import { tripFields, type Trip } from '../types/trip.js';

export interface TripSampleRow {
    trip_id: string;
    recorded_at: string;
    speed_kmh: number | null;
    acceleration: number;
    latitude: number | null;
    longitude: number | null;
}

export interface UserTripRepository {
    findActiveTrip(access: TripAccess): Promise<Trip | null>;
    /** Returns null when the account already has an active trip. */
    createActiveTrip(access: TripAccess): Promise<Trip | null>;
    /** Returns null when the trip does not exist or belongs to someone else. */
    findTrip(access: TripAccess, tripId: string): Promise<Trip | null>;
    replaceSamples(access: TripAccess, tripId: string, rows: TripSampleRow[]): Promise<void>;
}

const uniqueViolation = '23505';

export const userTripRepository: UserTripRepository = {
    async findActiveTrip(access) {
        const { data, error } = await createUserClient(access.accessToken)
            .from('trips')
            .select(tripFields)
            .eq('user_id', access.userId)
            .eq('status', 'Active')
            .maybeSingle();
        if (error) throw new Error(`Could not find active trip: ${error.message}`);
        return data as Trip | null;
    },

    async createActiveTrip(access) {
        const { data, error } = await createUserClient(access.accessToken)
            .from('trips')
            .insert({ user_id: access.userId, status: 'Active' })
            .select(tripFields)
            .single();
        if (error) {
            if (error.code === uniqueViolation) return null;
            throw new Error(`Could not create trip: ${error.message}`);
        }
        return data as Trip;
    },

    async findTrip(access, tripId) {
        const { data, error } = await createUserClient(access.accessToken)
            .from('trips')
            .select(tripFields)
            .eq('trip_id', tripId)
            .eq('user_id', access.userId)
            .maybeSingle();
        if (error) throw new Error(`Could not read trip: ${error.message}`);
        return data as Trip | null;
    },

    // A retry sends the whole trip again, so existing rows are cleared first
    // and the trip's samples end up stored exactly once.
    async replaceSamples(access, tripId, rows) {
        const client = createUserClient(access.accessToken);
        const { error: deleteError } = await client
            .from('trip_data_points')
            .delete()
            .eq('trip_id', tripId);
        if (deleteError) throw new Error(`Could not clear samples: ${deleteError.message}`);

        const { error: insertError } = await client.from('trip_data_points').insert(rows);
        if (insertError) throw new Error(`Could not save samples: ${insertError.message}`);
    },
};
