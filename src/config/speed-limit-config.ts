export interface SpeedLimitConfig {
    apiKey: string;
    timeoutMs: number;
    maxRequests: number;
}

export function loadSpeedLimitConfig(env: NodeJS.ProcessEnv): SpeedLimitConfig | null {
    const enabled = env.TRIP_SPEED_LIMIT_ENRICHMENT_ENABLED?.trim();
    if (!enabled || enabled === 'false') return null;
    if (enabled !== 'true') throw new Error('Invalid speed-limit enrichment switch.');
    const apiKey = env.TOMTOM_API_KEY?.trim();
    if (!apiKey) throw new Error('Missing TOMTOM_API_KEY.');
    const number = (key: string, fallback: number, max: number) => {
        const raw = env[key]?.trim();
        const n = raw ? Number(raw) : fallback;
        if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${key}.`);
        return n;
    };
    return { apiKey, timeoutMs: number('TOMTOM_TIMEOUT_MS', 10000, 15000),
        maxRequests: number('TOMTOM_MAX_REQUESTS_PER_TRIP', 8, 8) };
}
