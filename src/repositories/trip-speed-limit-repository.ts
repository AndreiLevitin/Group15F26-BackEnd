import { supabase } from '../lib/supabase.js';
import type { SpeedLimitRepository } from '../services/enrich-trip-speed-limits.js';
import type { SpeedLimitSample } from '../types/speed-limit.js';

export const tripSpeedLimitRepository: SpeedLimitRepository = {
    async readSamples(tripId) {
        const samples: SpeedLimitSample[] = [];
        const pageSize = 500;
        for (let offset = 0; ; offset += pageSize) {
            const { data, error } = await supabase.from('trip_data_points')
                .select('sample_id, recorded_at, latitude, longitude').eq('trip_id', tripId)
                .not('latitude', 'is', null).not('longitude', 'is', null)
                .order('recorded_at').order('sample_id').range(offset, offset + pageSize - 1);
            if (error) throw new Error('Could not read speed-limit trace.');
            for (const row of data ?? []) samples.push({ sampleId: row.sample_id,
                recordedAt: row.recorded_at, latitude: row.latitude, longitude: row.longitude });
            if (!data?.length || data.length < pageSize) break;
        }
        return samples;
    },
    async claim(tripId, traceHash, provider, token) {
        const { data, error } = await supabase.rpc('claim_trip_speed_limits', {
            p_trip_id: tripId, p_trace_hash: traceHash, p_provider: provider, p_token: token,
        });
        if (error || !['claimed', 'cached', 'busy'].includes(data)) throw new Error('Could not claim speed-limit enrichment.');
        return data as 'claimed' | 'cached' | 'busy';
    },
    async complete(tripId, token, samples, limits) {
        const { error } = await supabase.rpc('complete_trip_speed_limits', {
            p_trip_id: tripId, p_token: token, p_samples: samples, p_limits: limits,
        });
        if (error) throw new Error('Could not store speed-limit enrichment.');
    },
    async release(tripId, token) {
        const { error } = await supabase.rpc('release_trip_speed_limits', { p_trip_id: tripId, p_token: token });
        if (error) throw new Error('Could not release speed-limit enrichment.');
    },
};
