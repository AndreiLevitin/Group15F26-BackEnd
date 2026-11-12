import { supabase } from '../lib/supabase.js';
import { tripFields, type Trip } from '../types/trip.js';
import type { TripCompletionRepository } from '../services/complete-trip.js';

export const tripCompletionRepository: TripCompletionRepository = {
    async beginProcessing(tripId, endedAt) {
        const { data, error } = await supabase.from('trips').update({ end_time: endedAt, status: 'Processing' })
            .eq('trip_id', tripId).eq('status', 'Active').is('end_time', null).select(tripFields).maybeSingle();
        if (error) throw new Error('Could not transition trip.');
        return data as Trip | null;
    },
    async findTrip(tripId) {
        const { data, error } = await supabase.from('trips').select(tripFields).eq('trip_id', tripId).maybeSingle();
        if (error) throw new Error('Could not read trip state.');
        return data as Trip | null;
    },
};
