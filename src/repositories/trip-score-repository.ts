import { supabase } from '../lib/supabase.js';
import { tripFields, type Trip } from '../types/trip.js';
export async function saveTripScore(
    tripId: string,
    score: number | null,
): Promise<Trip | null> {
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) {
        throw new RangeError('trip score must be between 0 and 100, or null.');
    }

    const { data, error } = await supabase
        .from('trips')
        .update({
            trip_score: score,
            status: 'completed',
        })
        .eq('trip_id', tripId)
        .eq('status', 'processing')
        .not('end_time', 'is', null)
        .select(tripFields)
        .maybeSingle();
    if (error) {
        throw new Error(`could not save trip score: ${error.message}`);
    }
    return data ? (data as Trip) : null;
}