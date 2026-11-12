import { SpeedLimitProviderError } from '../types/speed-limit-errors.ts';
export { SpeedLimitProviderError } from '../types/speed-limit-errors.ts';
import type { SampleSpeedLimit, SpeedLimitProvider, SpeedLimitSample } from '../types/speed-limit.js';
import { chunkSpeedLimitTrace } from './speed-limit-chunks.ts';
import { hasValidCoordinates, gpsTimestampMillis } from './gps-validation.ts';

interface TomTomResponse {
    route: { properties: { id?: string; speedLimits?: { value?: number; unit?: string; type?: string } | null } }[];
    projectedPoints: { properties: { routeIndex?: number; snapResult: string } }[];
}

interface Options {
    apiKey: string;
    timeoutMs: number;
    maxRequests: number;
    fetch?: typeof fetch;
    now?: () => Date;
}

const fields = '{projectedPoints{properties{routeIndex,snapResult}},route{properties{id,speedLimits{value,unit,type}}}}';
const traceLimits = { maxPoints: 4900, maxDistanceKm: 80, breakDistanceKm: 5 };

/** Stateless adapter. One in-flight request per trip; maxRequests also bounds splitting/retries. */
export class TomTomSpeedLimitProvider implements SpeedLimitProvider {
    readonly name = 'tomtom';
    private readonly options: Options;
    constructor(options: Options) {
        if (!options.apiKey.trim() || !Number.isInteger(options.maxRequests) || options.maxRequests < 1 ||
            !Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
            throw new Error('Invalid TomTom configuration.');
        }
        this.options = options;
    }

    async fetchLimits(samples: readonly SpeedLimitSample[]): Promise<SampleSpeedLimit[]> {
        const now = this.options.now ?? (() => new Date());
        const unknown = (s: SpeedLimitSample, status: SampleSpeedLimit['status']): SampleSpeedLimit => ({
            sampleId: s.sampleId, speedLimitKmh: null, status, provider: this.name,
            fetchedAt: now().toISOString(), providerSegmentId: null,
        });
        const ids = new Set<string>();
        for (const s of samples) {
            if (ids.has(s.sampleId) || !hasValidCoordinates(s) || !Number.isFinite(gpsTimestampMillis(s.recordedAt))) {
                throw new Error('Invalid GPS trace.');
            }
            ids.add(s.sampleId);
        }
        const chunks = chunkSpeedLimitTrace(samples, traceLimits);
        // Deterministic oversized input must not consume quota again on every retry.
        if (chunks.filter(c => c.length >= 2).length > this.options.maxRequests) {
            throw new SpeedLimitProviderError('request_limit');
        }
        const results = new Map<string, SampleSpeedLimit>();
        let requests = 0;
        let lastRequestAt = 0;
        const runChunk = async (chunk: SpeedLimitSample[]): Promise<void> => {
            if (chunk.length < 2) {
                for (const sample of chunk) if (!results.has(sample.sampleId)) results.set(sample.sampleId, unknown(sample, 'insufficient_trace'));
                return;
            }
            if (++requests > this.options.maxRequests) throw new SpeedLimitProviderError('request_limit');
            // Space this trip's calls below the default 5 QPS. Concurrent trips can still
            // reach the account quota; a 429 fails explicitly and leaves scoring retryable.
            const delay = Math.max(0, 250 - (Date.now() - lastRequestAt));
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            lastRequestAt = Date.now();
            const url = new URL('https://api.tomtom.com/snapToRoads/1');
            url.searchParams.set('key', this.options.apiKey);
            url.searchParams.set('fields', fields);
            url.searchParams.set('measurementSystem', 'metric');
            url.searchParams.set('vehicleType', 'PassengerCar');
            let response: Response;
            try {
                response = await (this.options.fetch ?? fetch)(url, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ points: chunk.map(s => ({ type: 'Feature',
                        geometry: { type: 'Point', coordinates: [s.longitude, s.latitude] },
                        properties: { timestamp: s.recordedAt },
                    })) }),
                    signal: AbortSignal.timeout(this.options.timeoutMs),
                });
            } catch (error) {
                // Never retain an underlying URL/error that could contain the API key.
                throw new SpeedLimitProviderError(error instanceof Error &&
                    ['AbortError', 'TimeoutError'].includes(error.name) ? 'timeout' : 'request_failed');
            }
            // TomTom 400 can include routed-distance/point-gap limits not predictable from GPS distance.
            // Bounded subdivision retries smaller traces; a two-point rejection remains a failure.
            if (response.status === 400 && chunk.length > 2) {
                const middle = Math.floor(chunk.length / 2);
                await runChunk(chunk.slice(0, middle + 1));
                await runChunk(chunk.slice(middle));
                return;
            }
            if (!response.ok) {
                const code = response.status === 401 || response.status === 403 ? 'authentication_failed' :
                    response.status === 429 ? 'quota_exceeded' : response.status === 400 ? 'invalid_trace' : 'request_failed';
                throw new SpeedLimitProviderError(code, response.status);
            }
            let result: TomTomResponse;
            try {
                result = await response.json() as TomTomResponse;
                if (!Array.isArray(result.route) || !Array.isArray(result.projectedPoints) ||
                    result.projectedPoints.length !== chunk.length) throw new Error();
            } catch { throw new SpeedLimitProviderError('invalid_response'); }
            const fetchedAt = now().toISOString();
            chunk.forEach((s, i) => {
                const point = result.projectedPoints[i]?.properties;
                if (!point || typeof point.snapResult !== 'string') throw new SpeedLimitProviderError('invalid_response');
                let normalized = unknown(s, 'unmatched');
                if (point.snapResult === 'Matched') {
                    const index = point.routeIndex;
                    if (!Number.isInteger(index) || index! < 0 || index! >= result.route.length) {
                        throw new SpeedLimitProviderError('invalid_response');
                    }
                    const edge = result.route[index!]?.properties;
                    if (!edge) throw new SpeedLimitProviderError('invalid_response');
                    const limit = edge.speedLimits;
                    const value = limit?.unit === 'kmph' && limit.type === 'Maximum' &&
                        typeof limit.value === 'number' && Number.isFinite(limit.value) && limit.value > 0 ? limit.value : null;
                    normalized = { sampleId: s.sampleId, speedLimitKmh: value,
                        status: value === null ? 'missing' : 'available', provider: this.name, fetchedAt,
                        providerSegmentId: typeof edge.id === 'string' ? edge.id : null };
                }
                // First chunk owns an overlapping boundary sample, even if its limit is unknown.
                if (!results.has(s.sampleId)) results.set(s.sampleId, normalized);
            });
        };
        for (const chunk of chunks) await runChunk(chunk);
        return samples.map(s => results.get(s.sampleId)!);
    }
}
