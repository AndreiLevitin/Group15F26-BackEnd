import { createHash, randomUUID } from 'node:crypto';
import type { SampleSpeedLimit, SpeedLimitProvider, SpeedLimitSample } from '../types/speed-limit.js';

export interface SpeedLimitRepository {
    readSamples(tripId: string): Promise<SpeedLimitSample[]>;
    claim(tripId: string, traceHash: string, provider: string, token: string): Promise<'claimed' | 'cached' | 'busy'>;
    complete(tripId: string, token: string, samples: readonly SpeedLimitSample[], limits: readonly SampleSpeedLimit[]): Promise<void>;
    release(tripId: string, token: string): Promise<void>;
}

/** No partial writes: one failed chunk leaves the trip retryable and unscored. */
export async function enrichTripSpeedLimits(
    tripId: string,
    provider: SpeedLimitProvider,
    repository: SpeedLimitRepository,
): Promise<void> {
    const samples = await repository.readSamples(tripId);
    const hash = createHash('sha256').update(JSON.stringify(samples)).digest('hex');
    const token = randomUUID();
    const claim = await repository.claim(tripId, hash, provider.name, token);
    if (claim === 'cached') return;
    if (claim === 'busy') throw new Error('Trip speed-limit enrichment is already in progress.');
    try {
        const limits = await provider.fetchLimits(samples);
        const byId = new Map(limits.map(limit => [limit.sampleId, limit]));
        if (limits.length !== samples.length || byId.size !== samples.length || samples.some(s => {
            const limit = byId.get(s.sampleId);
            return !limit || limit.provider !== provider.name || !Number.isFinite(Date.parse(limit.fetchedAt)) ||
                (limit.status === 'available' ? !(typeof limit.speedLimitKmh === 'number' &&
                    Number.isFinite(limit.speedLimitKmh) && limit.speedLimitKmh > 0) : limit.speedLimitKmh !== null);
        })) throw new Error('Incomplete or invalid speed-limit enrichment.');
        await repository.complete(tripId, token, samples, limits);
    } catch (error) {
        // Failure to release is safe: a finite database lease allows later recovery.
        await repository.release(tripId, token).catch(() => {});
        throw error;
    }
}
