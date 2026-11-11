/** Stable database sample identifiers survive sorting, chunk overlap and duplicate times. */
export interface SpeedLimitSample {
    sampleId: string;
    recordedAt: string;
    latitude: number;
    longitude: number;
}

export type SpeedLimitStatus = 'available' | 'missing' | 'unmatched' | 'insufficient_trace';

export interface SampleSpeedLimit {
    sampleId: string;
    speedLimitKmh: number | null;
    status: SpeedLimitStatus;
    provider: string;
    fetchedAt: string;
    providerSegmentId: string | null;
}

/** Provider errors reject; they must never be normalized into missing road data. */
export interface SpeedLimitProvider {
    readonly name: string;
    fetchLimits(samples: readonly SpeedLimitSample[]): Promise<SampleSpeedLimit[]>;
}
