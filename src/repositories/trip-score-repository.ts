import { supabase } from '../lib/supabase.js';
import type { Trip } from '../types/trip.js';
import type { TripScoringResult } from '../services/trip-scoring.js';
import type { TripScoringConfig } from '../config/trip-scoring-config.js';
export async function saveTripScore(
    tripId: string,
    result: TripScoringResult,
    config: TripScoringConfig,
    distanceKm?: number,
): Promise<Trip | null> {
    if (result.score !== null && (!Number.isFinite(result.score) || result.score < 0 || result.score > 100)) {
        throw new RangeError('trip score must be between 0 and 100, or null.');
    }

    if (distanceKm !== undefined && (!Number.isFinite(distanceKm) || distanceKm < 0)) {
        throw new RangeError('Trip distance must be a finite non-negative number.');
    }

    // Score, interval decisions and exact config/distance are one transaction.
    const { data, error } = await supabase.rpc('save_trip_band_scoring_result', {
        p_trip_id: tripId, p_result: result, p_config: config, p_distance_km: distanceKm ?? null,
    });
    if (error) {
        throw new Error(`could not save trip score: ${error.message}`);
    }
    return data ? (data as Trip) : null;
}
